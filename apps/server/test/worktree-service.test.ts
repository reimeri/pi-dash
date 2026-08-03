import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createGitDiffInspector } from "../src/git/git-diff-inspector.js";
import { createGitInspector } from "../src/git/git-inspector.js";
import { createGitWorktreeManager } from "../src/git/git-worktree-manager.js";
import { createGitWorkspaceSynchronizer } from "../src/git/git-workspace-sync.js";
import { createWorkspaceRepository } from "../src/workspaces/workspace-repository.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";
import { createBaseSnapshotSigner } from "../src/worktrees/base-snapshot.js";
import { createRemovalConfirmationSigner } from "../src/worktrees/removal-confirmation.js";
import { createGitMutationLock } from "../src/worktrees/git-mutation-lock.js";
import { createWorktreeLifecycleCoordinator } from "../src/worktrees/worktree-lifecycle.js";
import { createWorktreeRepository } from "../src/worktrees/worktree-repository.js";
import {
  createWorktreeService,
  WorktreeServiceError,
} from "../src/worktrees/worktree-service.js";
import { createGitRepository } from "../../../tests/fixtures/git-repository.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    stopRuntime?: () => Promise<void>;
    onMembershipChange?: (change: {
      type: "upsert" | "removed";
      worktreeId: string;
      workspaceId: string;
    }) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-worktree-service-"));
  roots.push(root);
  const repositoryPath = createGitRepository(root, "repository");
  const database = await openDatabase({
    path: join(root, "pi-dash.sqlite"),
    migrationsDirectory,
  });
  const workspaceRepository = createWorkspaceRepository(database.sqlite);
  const inspector = await createGitInspector();
  const lockRoot = join(root, "locks");
  mkdirSync(lockRoot, { mode: 0o700 });
  const lock = createGitMutationLock({ root: lockRoot });
  const workspaceService = createWorkspaceService({
    repository: workspaceRepository,
    git: inspector,
    syncer: await createGitWorkspaceSynchronizer(),
    lock,
  });
  const workspace = await workspaceService.create({
    path: repositoryPath,
    name: "Example Repository",
  });
  const worktreeRepository = createWorktreeRepository(database.sqlite);
  const manager = await createGitWorktreeManager();
  const diffs = await createGitDiffInspector();
  const service = createWorktreeService({
    repository: worktreeRepository,
    workspaces: workspaceRepository,
    git: manager,
    diffs,
    lock,
    lifecycle: createWorktreeLifecycleCoordinator({
      repository: worktreeRepository,
    }),
    snapshots: createBaseSnapshotSigner({ key: Buffer.alloc(32, 7) }),
    removalConfirmations: createRemovalConfirmationSigner({
      key: Buffer.alloc(32, 8),
    }),
    managedRoot: join(root, "managed"),
    stopRuntime: options.stopRuntime,
    onMembershipChange: options.onMembershipChange,
  });
  return {
    root,
    repositoryPath,
    database,
    workspace,
    service,
    manager,
    worktreeRepository,
    workspaceService,
  };
}

async function removalInput(
  service: ReturnType<typeof createWorktreeService>,
  worktreeId: string,
  mode: "safe" | "force" = "safe",
) {
  const inspection = await service.prepareRemoval(worktreeId);
  return mode === "safe"
    ? ({
        mode: "safe",
        confirmationToken: inspection.confirmationToken,
      } as const)
    : ({
        mode: "force",
        confirmationToken: inspection.confirmationToken,
        confirmation: "delete",
      } as const);
}

async function removePrepared(
  service: ReturnType<typeof createWorktreeService>,
  worktreeId: string,
  idempotencyKey: string,
  mode: "safe" | "force" = "safe",
) {
  const response = await service.remove(
    worktreeId,
    await removalInput(service, worktreeId, mode),
    idempotencyKey,
  );
  if (response.outcome !== "removed_with_branch_cleanup") {
    throw new Error("Expected a removal tombstone");
  }
  return response;
}

describe("WorktreeService integration", () => {
  it("creates from the token-bound commit even after the base ref moves", async () => {
    const { repositoryPath, database, workspace, service } = await fixture();
    const refs = await service.refs(workspace.id);
    expect(refs.head).not.toBeNull();
    const snapshot = refs.head!;

    writeFileSync(join(repositoryPath, "later.txt"), "later\n");
    execFileSync("git", ["add", "--", "later.txt"], { cwd: repositoryPath });
    execFileSync("git", ["commit", "-m", "Move main"], {
      cwd: repositoryPath,
      stdio: "ignore",
    });

    const input = {
      name: "OAuth refresh",
      slug: "oauth-refresh",
      baseRef: snapshot.fullName,
      baseCommit: snapshot.commit,
      baseSnapshotToken: snapshot.baseSnapshotToken,
    };
    const operationKey = crypto.randomUUID();
    const created = await service.create(workspace.id, input, operationKey);
    expect(created.worktree).toMatchObject({
      lifecycle: "ready",
      health: "healthy",
      dirty: false,
      branchRef: "refs/heads/pi-dash/oauth-refresh",
      baseCommit: snapshot.commit,
    });
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: created.worktree.path,
        encoding: "utf8",
      }).trim(),
    ).toBe(snapshot.commit);

    const replay = await service.create(workspace.id, input, operationKey);
    expect(replay).toEqual(created);
    database.close();
  });

  it("serves live diffs only for an exact ready managed worktree", async () => {
    const { database, workspace, service } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Diff viewer",
        slug: "diff-viewer",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    writeFileSync(
      join(created.worktree.path, "change.ts"),
      "export const changed = true;\n",
    );

    await expect(
      service.diffSummary(created.worktree.id),
    ).resolves.toMatchObject({
      worktreeId: created.worktree.id,
      headCommit: snapshot.commit,
      hasChanges: true,
      filesChanged: 1,
      additions: 1,
      deletions: 0,
    });
    const diff = await service.diff(created.worktree.id);
    expect(diff.patch).toContain("diff --git a/change.ts b/change.ts");
    expect(diff.checkedAt).toMatch(/Z$/);
    database.close();
  });

  it("allows the same managed branch name in different repositories", async () => {
    const { root, database, workspace, service, workspaceService } =
      await fixture();
    const secondRepository = createGitRepository(root, "second-repository");
    const secondWorkspace = await workspaceService.create({
      path: secondRepository,
      name: "Second Repository",
    });
    const firstSnapshot = (await service.refs(workspace.id)).head!;
    const secondSnapshot = (await service.refs(secondWorkspace.id)).head!;

    const first = await service.create(
      workspace.id,
      {
        name: "Shared slug",
        slug: "shared-slug",
        baseRef: firstSnapshot.fullName,
        baseCommit: firstSnapshot.commit,
        baseSnapshotToken: firstSnapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    const second = await service.create(
      secondWorkspace.id,
      {
        name: "Shared slug",
        slug: "shared-slug",
        baseRef: secondSnapshot.fullName,
        baseCommit: secondSnapshot.commit,
        baseSnapshotToken: secondSnapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );

    expect(first.worktree.branchRef).toBe("refs/heads/pi-dash/shared-slug");
    expect(second.worktree.branchRef).toBe(first.worktree.branchRef);
    expect(second.worktree.lifecycle).toBe("ready");
    database.close();
  });

  it("never compensates by deleting a pre-existing external branch", async () => {
    const { repositoryPath, database, workspace, service } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const branch = "pi-dash/preexisting";
    execFileSync("git", ["branch", branch, snapshot.commit], {
      cwd: repositoryPath,
    });

    await expect(
      service.create(
        workspace.id,
        {
          name: "Preexisting",
          slug: "preexisting",
          baseRef: snapshot.fullName,
          baseCommit: snapshot.commit,
          baseSnapshotToken: snapshot.baseSnapshotToken,
        },
        crypto.randomUUID(),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorktreeServiceError>>({
        code: "BRANCH_EXISTS",
      }),
    );
    expect(
      execFileSync("git", ["show-ref", "--verify", `refs/heads/${branch}`], {
        cwd: repositoryPath,
        encoding: "utf8",
      }),
    ).toContain(snapshot.commit);
    database.close();
  });

  it("restores ready when the runtime stop hook fails before Git mutation", async () => {
    const { database, workspace, service } = await fixture({
      stopRuntime: async () => {
        throw new Error("injected stop failure");
      },
    });
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Stop failure",
        slug: "stop-failure",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );

    await expect(
      removePrepared(service, created.worktree.id, crypto.randomUUID()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorktreeServiceError>>({
        code: "WORKTREE_REMOVE_FAILED",
      }),
    );
    expect(service.get(created.worktree.id)).toMatchObject({
      lifecycle: "ready",
      health: "healthy",
    });
    database.close();
  });

  it("does not let a losing concurrent removal restore the winner to ready", async () => {
    let announceStop!: () => void;
    const stopEntered = new Promise<void>((resolve) => {
      announceStop = resolve;
    });
    let releaseStop!: () => void;
    const stopReleased = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const { database, workspace, service } = await fixture({
      stopRuntime: async () => {
        announceStop();
        await stopReleased;
      },
    });
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Concurrent removal",
        slug: "concurrent-removal",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    const firstInput = await removalInput(service, created.worktree.id);
    const secondInput = await removalInput(service, created.worktree.id);
    const first = service.remove(
      created.worktree.id,
      firstInput,
      crypto.randomUUID(),
    );
    const second = service.remove(
      created.worktree.id,
      secondInput,
      crypto.randomUUID(),
    );

    await stopEntered;
    await expect(Promise.race([first, second])).rejects.toMatchObject({
      code: "WORKTREE_REMOVAL_CHANGED",
    });
    expect(service.get(created.worktree.id).lifecycle).toBe("removing");
    releaseStop();
    const outcomes = await Promise.allSettled([first, second]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(service.get(created.worktree.id).lifecycle).toBe("removed");
    database.close();
  });

  it("reconciles a crash after Git removal and completes the durable operation", async () => {
    const {
      database,
      repositoryPath,
      workspace,
      service,
      manager,
      worktreeRepository,
    } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Interrupted removal",
        slug: "interrupted-removal",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    const operationId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    worktreeRepository.createOperation({
      id: operationId,
      idempotencyKey,
      operationType: "remove",
      workspaceId: workspace.id,
      worktreeId: created.worktree.id,
      requestHash: "f".repeat(64),
      requestJson: JSON.stringify({ id: created.worktree.id }),
      status: "in_progress",
      httpStatus: null,
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const identity = lstatSync(created.worktree.path, { bigint: true });
    worktreeRepository.createRemovalJournal({
      operationId,
      workspaceId: workspace.id,
      worktreeId: created.worktree.id,
      mode: "safe",
      priorLifecycle: "ready",
      strategy: "git",
      phase: "mutation_started",
      originalPath: created.worktree.path,
      quarantinePath: null,
      originalDevice: identity.dev.toString(),
      originalInode: identity.ino.toString(),
      originalKind: "directory",
      recordedBranchRef: created.worktree.branchRef,
      cleanupBranchRef: created.worktree.branchRef,
      cleanupBranchTip: created.worktree.baseCommit,
      inspectionJson: "{}",
      warningsJson: "[]",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    worktreeRepository.updateState(created.worktree.id, {
      lifecycle: "removing",
      finalBranchTip: null,
      updatedAt: timestamp,
    });
    await manager.remove(repositoryPath, created.worktree.path);

    await service.reconcile(workspace.id);
    expect(service.get(created.worktree.id)).toMatchObject({
      lifecycle: "removed",
      finalBranchTip: created.worktree.baseCommit,
    });
    expect(worktreeRepository.findOperation(idempotencyKey)).toMatchObject({
      status: "succeeded",
      httpStatus: 200,
    });
    database.close();
  });

  it("reconciles durable branch-deletion intent when the branch is absent", async () => {
    const {
      database,
      repositoryPath,
      workspace,
      service,
      manager,
      worktreeRepository,
    } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Interrupted branch deletion",
        slug: "interrupted-branch-deletion",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    const removed = await removePrepared(
      service,
      created.worktree.id,
      crypto.randomUUID(),
    );
    const operationId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    worktreeRepository.createOperation({
      id: operationId,
      idempotencyKey,
      operationType: "delete_branch",
      workspaceId: workspace.id,
      worktreeId: created.worktree.id,
      requestHash: "e".repeat(64),
      requestJson: JSON.stringify({
        id: created.worktree.id,
        expectedBranchTip: removed.branchCleanup.branchTip,
        safetyTargetCommit: snapshot.commit,
      }),
      status: "in_progress",
      httpStatus: null,
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await manager.deleteBranch(
      repositoryPath,
      created.worktree.branchRef,
      removed.branchCleanup.branchTip,
    );
    const originalBranchExists = manager.branchExists.bind(manager);
    manager.branchExists = async () => {
      throw new Error("injected branch inspection failure");
    };

    await service.reconcile(workspace.id);
    expect(worktreeRepository.get(created.worktree.id)).toBeDefined();
    expect(worktreeRepository.findOperation(idempotencyKey)?.status).toBe(
      "in_progress",
    );

    manager.branchExists = originalBranchExists;
    await service.reconcile(workspace.id);

    expect(worktreeRepository.get(created.worktree.id)).toBeUndefined();
    expect(worktreeRepository.findOperation(idempotencyKey)).toMatchObject({
      status: "succeeded",
      httpStatus: 200,
      worktreeId: created.worktree.id,
    });
    database.close();
  });

  it("leaves post-Git finalization failures recoverable", async () => {
    const { database, workspace, service, worktreeRepository } =
      await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Finalization failure",
        slug: "finalization-failure",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    const removed = await removePrepared(
      service,
      created.worktree.id,
      crypto.randomUUID(),
    );
    const operationKey = crypto.randomUUID();
    const originalFinalize = worktreeRepository.finalizeBranchDeletion;
    worktreeRepository.finalizeBranchDeletion = () => {
      throw new Error("injected finalization failure");
    };

    await expect(
      service.deleteBranch(
        created.worktree.id,
        {
          expectedBranchTip: removed.branchCleanup.branchTip,
          safetyTargetCommit: snapshot.commit,
        },
        operationKey,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorktreeServiceError>>({
        code: "OPERATION_IN_PROGRESS",
      }),
    );
    expect(worktreeRepository.findOperation(operationKey)?.status).toBe(
      "in_progress",
    );

    worktreeRepository.finalizeBranchDeletion = originalFinalize;
    await service.reconcile(workspace.id);
    expect(worktreeRepository.get(created.worktree.id)).toBeUndefined();
    expect(worktreeRepository.findOperation(operationKey)?.status).toBe(
      "succeeded",
    );
    database.close();
  });

  it("keeps an unmerged branch after the worktree is removed", async () => {
    const { repositoryPath, database, workspace, service } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Unmerged work",
        slug: "unmerged-work",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    writeFileSync(join(created.worktree.path, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "--", "feature.txt"], {
      cwd: created.worktree.path,
    });
    execFileSync("git", ["commit", "-m", "Feature commit"], {
      cwd: created.worktree.path,
      stdio: "ignore",
    });
    const removed = await removePrepared(
      service,
      created.worktree.id,
      crypto.randomUUID(),
    );

    await expect(
      service.deleteBranch(
        created.worktree.id,
        {
          expectedBranchTip: removed.branchCleanup.branchTip,
          safetyTargetCommit: snapshot.commit,
        },
        crypto.randomUUID(),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorktreeServiceError>>({
        code: "BRANCH_NOT_MERGED",
      }),
    );
    expect(
      execFileSync(
        "git",
        ["show-ref", "--verify", created.worktree.branchRef],
        {
          cwd: repositoryPath,
          encoding: "utf8",
        },
      ),
    ).toContain(removed.branchCleanup.branchTip);
    database.close();
  });

  it("reports a changed branch and force-removes it with explicit adoption", async () => {
    const { database, repositoryPath, workspace, service, manager } =
      await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Changed branch",
        slug: "changed-branch",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    const adoptedRef = "refs/heads/pi-dash/adopted-branch";
    execFileSync("git", ["branch", adoptedRef.slice("refs/heads/".length)], {
      cwd: repositoryPath,
    });
    execFileSync("git", ["switch", adoptedRef.slice("refs/heads/".length)], {
      cwd: created.worktree.path,
      stdio: "ignore",
    });

    const inspection = await service.prepareRemoval(created.worktree.id);
    expect(inspection).toMatchObject({
      safeRemovalAllowed: false,
      forceRemovalAllowed: true,
      removalStrategy: "git",
      observed: { branchRef: adoptedRef },
      branchDisposition: {
        kind: "adopt_observed",
        cleanupBranchRef: adoptedRef,
        untouchedBranchRefs: [created.worktree.branchRef],
      },
    });
    expect(inspection.issues).toContainEqual(
      expect.objectContaining({
        code: "BRANCH_CHANGED",
        summary: expect.stringContaining(created.worktree.branchRef),
      }),
    );
    await expect(
      service.remove(
        created.worktree.id,
        {
          mode: "force",
          confirmationToken: inspection.confirmationToken,
        },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_REMOVAL_CONFIRMATION_INVALID",
    });

    const removed = await service.remove(
      created.worktree.id,
      {
        mode: "force",
        confirmationToken: inspection.confirmationToken,
        confirmation: "delete",
      },
      crypto.randomUUID(),
    );
    expect(removed.outcome).toBe("removed_with_branch_cleanup");
    if (removed.outcome !== "removed_with_branch_cleanup") return;
    expect(removed.branchCleanup.branchRef).toBe(adoptedRef);
    expect(removed.worktree.branchRef).toBe(adoptedRef);
    expect(removed.warnings.join(" ")).toContain(created.worktree.branchRef);
    expect(existsSync(created.worktree.path)).toBe(false);
    expect(
      await manager.branchExists(repositoryPath, created.worktree.branchRef),
    ).toBe(true);
    database.close();
  });

  it("does not adopt an observed branch when Git removal fails intact", async () => {
    const { database, repositoryPath, workspace, service, manager } =
      await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Failed adoption",
        slug: "failed-adoption",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    const observedRef = "refs/heads/pi-dash/failed-adoption-observed";
    execFileSync("git", ["branch", observedRef.slice("refs/heads/".length)], {
      cwd: repositoryPath,
    });
    execFileSync("git", ["switch", observedRef.slice("refs/heads/".length)], {
      cwd: created.worktree.path,
      stdio: "ignore",
    });
    const inspection = await service.prepareRemoval(created.worktree.id);
    const originalRemove = manager.remove.bind(manager);
    manager.remove = async () => {
      throw new Error("injected Git removal failure");
    };

    await expect(
      service.remove(
        created.worktree.id,
        {
          mode: "force",
          confirmationToken: inspection.confirmationToken,
          confirmation: "delete",
        },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "WORKTREE_REMOVE_FAILED" });
    manager.remove = originalRemove;
    expect(service.get(created.worktree.id)).toMatchObject({
      lifecycle: "ready",
      branchRef: created.worktree.branchRef,
      finalBranchTip: null,
    });
    database.close();
  });

  it("force-removes dirty locked worktrees after typed confirmation", async () => {
    const { database, repositoryPath, workspace, service } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Dirty locked",
        slug: "dirty-locked",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    writeFileSync(join(created.worktree.path, "discard-me.txt"), "discard\n");
    execFileSync(
      "git",
      ["worktree", "lock", "--reason", "external owner", created.worktree.path],
      { cwd: repositoryPath },
    );

    const inspection = await service.prepareRemoval(created.worktree.id);
    expect(inspection.dirty).toMatchObject({
      available: true,
      dirty: true,
      untracked: 1,
    });
    expect(inspection.observed).toMatchObject({
      locked: true,
      lockReason: "external owner",
    });
    const removed = await service.remove(
      created.worktree.id,
      {
        mode: "force",
        confirmationToken: inspection.confirmationToken,
        confirmation: "delete",
      },
      crypto.randomUUID(),
    );
    expect(removed.outcome).toBe("removed_with_branch_cleanup");
    expect(existsSync(created.worktree.path)).toBe(false);
    database.close();
  });

  it("quarantines an unprovable allocation, forgets it, and preserves external data", async () => {
    const {
      root,
      database,
      repositoryPath,
      workspace,
      service,
      manager,
      worktreeRepository,
    } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Unprovable",
        slug: "unprovable",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    await manager.remove(repositoryPath, created.worktree.path);
    const external = join(root, "external-data");
    mkdirSync(external);
    writeFileSync(join(external, "keep.txt"), "keep\n");
    symlinkSync(external, created.worktree.path);

    const inspection = await service.prepareRemoval(created.worktree.id);
    expect(inspection).toMatchObject({
      safeRemovalAllowed: false,
      forceRemovalAllowed: true,
      removalStrategy: "filesystem_only",
      observed: { pathKind: "symlink" },
      branchDisposition: { kind: "manual", cleanupBranchRef: null },
    });
    const operationKey = crypto.randomUUID();
    const removed = await service.remove(
      created.worktree.id,
      {
        mode: "force",
        confirmationToken: inspection.confirmationToken,
        confirmation: "delete",
      },
      operationKey,
    );
    expect(removed).toMatchObject({
      outcome: "forgotten",
      worktreeId: created.worktree.id,
      workspaceId: workspace.id,
    });
    expect(existsSync(created.worktree.path)).toBe(false);
    expect(existsSync(join(external, "keep.txt"))).toBe(true);
    expect(worktreeRepository.get(created.worktree.id)).toBeUndefined();
    expect(worktreeRepository.findOperation(operationKey)).toMatchObject({
      status: "succeeded",
      httpStatus: 200,
    });
    database.close();
  });

  it("reconciles filesystem-only finalization failure after purge", async () => {
    const {
      database,
      repositoryPath,
      workspace,
      service,
      manager,
      worktreeRepository,
    } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Purge finalization failure",
        slug: "purge-finalization-failure",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    await manager.remove(repositoryPath, created.worktree.path);
    mkdirSync(created.worktree.path);
    writeFileSync(join(created.worktree.path, "discard.txt"), "discard\n");
    const inspection = await service.prepareRemoval(created.worktree.id);
    expect(inspection.removalStrategy).toBe("filesystem_only");
    const operationKey = crypto.randomUUID();
    const originalFinalize = worktreeRepository.finalizeForgottenRemoval;
    worktreeRepository.finalizeForgottenRemoval = () => {
      throw new Error("injected forgotten finalization failure");
    };

    await expect(
      service.remove(
        created.worktree.id,
        {
          mode: "force",
          confirmationToken: inspection.confirmationToken,
          confirmation: "delete",
        },
        operationKey,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
    expect(existsSync(created.worktree.path)).toBe(false);
    expect(worktreeRepository.findOperation(operationKey)?.status).toBe(
      "in_progress",
    );
    expect(
      worktreeRepository.getRemovalJournal(
        worktreeRepository.findOperation(operationKey)!.id,
      )?.phase,
    ).toBe("purged");

    worktreeRepository.finalizeForgottenRemoval = originalFinalize;
    await service.reconcile(workspace.id);
    expect(worktreeRepository.get(created.worktree.id)).toBeUndefined();
    expect(worktreeRepository.findOperation(operationKey)).toMatchObject({
      status: "succeeded",
      httpStatus: 200,
    });
    database.close();
  });

  it("reconciles a crash after filesystem quarantine and forgets the record", async () => {
    const {
      database,
      repositoryPath,
      workspace,
      service,
      manager,
      worktreeRepository,
    } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Quarantine recovery",
        slug: "quarantine-recovery",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    await manager.remove(repositoryPath, created.worktree.path);
    mkdirSync(created.worktree.path);
    writeFileSync(join(created.worktree.path, "partial.txt"), "partial\n");

    const operationId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const quarantineRoot = join(created.worktree.path, "..", ".pi-dash-trash");
    mkdirSync(quarantineRoot, { recursive: true });
    const quarantinePath = join(quarantineRoot, operationId);
    renameSync(created.worktree.path, quarantinePath);
    const quarantineIdentity = lstatSync(quarantinePath, { bigint: true });
    worktreeRepository.createOperation({
      id: operationId,
      idempotencyKey,
      operationType: "remove",
      workspaceId: workspace.id,
      worktreeId: created.worktree.id,
      requestHash: "d".repeat(64),
      requestJson: JSON.stringify({ id: created.worktree.id, mode: "force" }),
      status: "in_progress",
      httpStatus: null,
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    worktreeRepository.createRemovalJournal({
      operationId,
      workspaceId: workspace.id,
      worktreeId: created.worktree.id,
      mode: "force",
      priorLifecycle: "ready",
      strategy: "filesystem_only",
      phase: "quarantined",
      originalPath: created.worktree.path,
      quarantinePath,
      originalDevice: quarantineIdentity.dev.toString(),
      originalInode: quarantineIdentity.ino.toString(),
      originalKind: "directory",
      recordedBranchRef: created.worktree.branchRef,
      cleanupBranchRef: null,
      cleanupBranchTip: null,
      inspectionJson: "{}",
      warningsJson: JSON.stringify(["Git metadata was left untouched"]),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    worktreeRepository.updateState(created.worktree.id, {
      lifecycle: "removing",
      updatedAt: timestamp,
    });

    await service.reconcile(workspace.id);
    expect(existsSync(quarantinePath)).toBe(false);
    expect(worktreeRepository.get(created.worktree.id)).toBeUndefined();
    expect(worktreeRepository.findOperation(idempotencyKey)).toMatchObject({
      status: "succeeded",
      httpStatus: 200,
    });
    database.close();
  });

  it("rejects a stale removal confirmation with a fresh mismatch report", async () => {
    const { database, repositoryPath, workspace, service } = await fixture();
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Stale confirmation",
        slug: "stale-confirmation",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    const inspection = await service.prepareRemoval(created.worktree.id);
    const changedRef = "refs/heads/pi-dash/changed-after-review";
    execFileSync("git", ["branch", changedRef.slice("refs/heads/".length)], {
      cwd: repositoryPath,
    });
    execFileSync("git", ["switch", changedRef.slice("refs/heads/".length)], {
      cwd: created.worktree.path,
      stdio: "ignore",
    });

    await expect(
      service.remove(
        created.worktree.id,
        { mode: "safe", confirmationToken: inspection.confirmationToken },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({
      code: "WORKTREE_REMOVAL_CHANGED",
      details: expect.objectContaining({
        observed: expect.objectContaining({ branchRef: changedRef }),
      }),
    });
    database.close();
  });

  it("deletes a completed tombstone, preserves retries, and allows slug reuse", async () => {
    const membershipChanges: Array<{
      type: "upsert" | "removed";
      worktreeId: string;
      workspaceId: string;
    }> = [];
    const { database, workspace, service, worktreeRepository } = await fixture({
      onMembershipChange: (change) => membershipChanges.push(change),
    });
    const snapshot = (await service.refs(workspace.id)).head!;
    const created = await service.create(
      workspace.id,
      {
        name: "Clean removal",
        slug: "clean-removal",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );

    const dirt = join(created.worktree.path, "untracked.txt");
    writeFileSync(dirt, "do not delete\n");
    await expect(
      removePrepared(service, created.worktree.id, crypto.randomUUID()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorktreeServiceError>>({
        code: "WORKTREE_DIRTY",
      }),
    );
    expect(() => unlinkSync(dirt)).not.toThrow();
    writeFileSync(join(created.worktree.path, "README.md"), "tracked change\n");
    await expect(
      removePrepared(service, created.worktree.id, crypto.randomUUID()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorktreeServiceError>>({
        code: "WORKTREE_DIRTY",
      }),
    );
    execFileSync("git", ["checkout", "--", "README.md"], {
      cwd: created.worktree.path,
    });

    const removeKey = crypto.randomUUID();
    const removeInput = await removalInput(service, created.worktree.id);
    const removed = await service.remove(
      created.worktree.id,
      removeInput,
      removeKey,
    );
    if (removed.outcome !== "removed_with_branch_cleanup") {
      throw new Error("Expected a removal tombstone");
    }
    expect(removed.worktree.lifecycle).toBe("removed");

    const deletionInput = {
      expectedBranchTip: removed.branchCleanup.branchTip,
      safetyTargetCommit: snapshot.commit,
    };
    const deleteKey = crypto.randomUUID();
    const deleted = await service.deleteBranch(
      created.worktree.id,
      deletionInput,
      deleteKey,
    );
    expect(deleted).toEqual({
      operationId: expect.any(String),
      deleted: true,
      atomic: true,
      worktreeId: created.worktree.id,
      workspaceId: workspace.id,
    });
    expect(worktreeRepository.get(created.worktree.id)).toBeUndefined();
    expect(service.list(workspace.id)).toEqual([]);
    expect(
      await service.deleteBranch(created.worktree.id, deletionInput, deleteKey),
    ).toEqual(deleted);
    expect(
      await service.remove(created.worktree.id, removeInput, removeKey),
    ).toEqual(removed);
    await expect(
      service.deleteBranch(
        created.worktree.id,
        deletionInput,
        crypto.randomUUID(),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorktreeServiceError>>({
        code: "WORKTREE_NOT_MANAGED",
      }),
    );

    const recreated = await service.create(
      workspace.id,
      {
        name: "Clean removal reused",
        slug: "clean-removal",
        baseRef: snapshot.fullName,
        baseCommit: snapshot.commit,
        baseSnapshotToken: snapshot.baseSnapshotToken,
      },
      crypto.randomUUID(),
    );
    expect(recreated.worktree.branchRef).toBe(created.worktree.branchRef);
    expect(membershipChanges).toEqual([
      {
        type: "upsert",
        worktreeId: created.worktree.id,
        workspaceId: workspace.id,
      },
      {
        type: "upsert",
        worktreeId: created.worktree.id,
        workspaceId: workspace.id,
      },
      {
        type: "removed",
        worktreeId: created.worktree.id,
        workspaceId: workspace.id,
      },
      {
        type: "upsert",
        worktreeId: recreated.worktree.id,
        workspaceId: workspace.id,
      },
    ]);
    database.close();
  });
});
