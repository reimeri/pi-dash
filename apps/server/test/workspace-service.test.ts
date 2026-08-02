import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDto } from "@pi-dash/contracts";
import { createGitRepository } from "../../../tests/fixtures/git-repository.js";
import { createGitInspector } from "../src/git/git-inspector.js";
import {
  createGitWorkspaceSynchronizer,
  type GitWorkspaceSynchronizer,
} from "../src/git/git-workspace-sync.js";
import { openDatabase, type DatabaseService } from "../src/database.js";
import { createWorkspaceRepository } from "../src/workspaces/workspace-repository.js";
import { createGitMutationLock } from "../src/worktrees/git-mutation-lock.js";
import {
  createWorkspaceService,
  workspaceSlugBase,
  type WorkspaceService,
} from "../src/workspaces/workspace-service.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);
const resources: Array<{ root: string; database: DatabaseService }> = [];

async function fixture(
  options: {
    syncer?: GitWorkspaceSynchronizer;
    onRepositoryChange?: (workspace: WorkspaceDto) => void;
  } = {},
): Promise<{
  root: string;
  database: DatabaseService;
  service: WorkspaceService;
}> {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-workspace-"));
  const database = await openDatabase({
    path: join(root, "database.sqlite"),
    migrationsDirectory,
  });
  const service = createWorkspaceService({
    repository: createWorkspaceRepository(database.sqlite),
    git: await createGitInspector({
      now: () => new Date("2026-02-03T04:05:06.000Z"),
    }),
    syncer: options.syncer ?? (await createGitWorkspaceSynchronizer()),
    lock: createGitMutationLock({ root: join(root, "locks") }),
    onRepositoryChange: options.onRepositoryChange,
    now: () => new Date("2026-02-03T04:05:06.000Z"),
  });
  resources.push({ root, database });
  return { root, database, service };
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ root, database }) => {
      database.close();
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("WorkspaceService", () => {
  it("registers canonical repositories once, including symlink aliases", async () => {
    const { root, service } = await fixture();
    const repository = createGitRepository(root, "project");
    const alias = join(root, "alias");
    symlinkSync(repository, alias);

    const created = await service.create({ path: alias, name: " Project " });
    expect(created).toMatchObject({
      name: "Project",
      slug: "project",
      repositoryPath: repository,
      repository: { health: "healthy", currentBranch: "main" },
      worktreeCount: 0,
    });
    await expect(
      service.create({ path: repository, name: "Duplicate" }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_EXISTS",
      details: { workspaceId: created.id, workspaceName: "Project" },
    });
    expect(service.list()).toHaveLength(1);
  });

  it("uses unique immutable slugs and deterministic name ordering", async () => {
    const { root, service } = await fixture();
    const firstRepository = createGitRepository(root, "first");
    const secondRepository = createGitRepository(root, "second");
    const first = await service.create({
      path: firstRepository,
      name: "Pi Däsh",
    });
    const second = await service.create({
      path: secondRepository,
      name: "Pi Dash",
    });
    expect(first.slug).toBe("pi-dash");
    expect(second.slug).toBe("pi-dash-2");

    const renamed = service.rename(first.id, "Zebra");
    expect(renamed.slug).toBe("pi-dash");
    expect(service.list().map((workspace) => workspace.name)).toEqual([
      "Pi Dash",
      "Zebra",
    ]);
    expect(workspaceSlugBase("你好")).toBe("workspace");
  });

  it("refreshes the upstream sync status for healthy repositories", async () => {
    let statusChecks = 0;
    let statusFails = false;
    const publishedStatuses: string[] = [];
    const { root, service } = await fixture({
      onRepositoryChange: (workspace) =>
        publishedStatuses.push(workspace.repository.syncStatus),
      syncer: {
        async status() {
          statusChecks += 1;
          if (statusFails) throw new Error("status failed");
          return "syncable";
        },
        async sync(path) {
          return {
            headCommit: execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: path,
              encoding: "utf8",
            }).trim(),
          };
        },
      },
    });
    const repository = createGitRepository(root, "project");
    const created = await service.create({ path: repository, name: "Project" });

    expect(created.repository.syncStatus).toBe("unknown");
    await expect(service.refresh(created.id)).resolves.toMatchObject({
      repository: { health: "healthy", syncStatus: "syncable" },
    });
    expect(statusChecks).toBe(1);
    expect(service.get(created.id).repository.syncStatus).toBe("syncable");

    statusFails = true;
    await expect(service.refresh(created.id)).rejects.toThrow("status failed");
    expect(service.get(created.id).repository.syncStatus).toBe("unknown");
    expect(publishedStatuses.at(-1)).toBe("unknown");
  });

  it("persists degraded missing health and removes metadata without repository files", async () => {
    const { root, service } = await fixture();
    const repository = createGitRepository(root, "movable");
    const created = await service.create({ path: repository, name: "Movable" });
    rmSync(repository, { recursive: true, force: true });

    const degraded = await service.refresh(created.id);
    expect(degraded.repository).toMatchObject({
      health: "missing",
      currentBranch: null,
      headCommit: null,
      checkedAt: "2026-02-03T04:05:06.000Z",
    });
    expect(service.get(created.id).repository.health).toBe("missing");
    service.remove(created.id);
    expect(service.list()).toEqual([]);
  });

  it("blocks removal while a workspace sync is active", async () => {
    let started!: () => void;
    let release!: () => void;
    const syncStarted = new Promise<void>((resolve) => (started = resolve));
    const continueSync = new Promise<void>((resolve) => (release = resolve));
    const { root, service } = await fixture({
      syncer: {
        async status() {
          return "synchronized";
        },
        async sync(path) {
          started();
          await continueSync;
          return {
            headCommit: execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: path,
              encoding: "utf8",
            }).trim(),
          };
        },
      },
    });
    const repository = createGitRepository(root, "project");
    const workspace = await service.create({
      path: repository,
      name: "Project",
    });

    const syncing = service.sync(workspace.id);
    await syncStarted;
    expect(() => service.remove(workspace.id)).toThrow(
      expect.objectContaining({ code: "GIT_OPERATION_BUSY" }),
    );
    release();
    await expect(syncing).resolves.toMatchObject({ id: workspace.id });
  });

  it("blocks removal while an upstream status refresh is active", async () => {
    let started!: () => void;
    let release!: () => void;
    const refreshStarted = new Promise<void>((resolve) => (started = resolve));
    const continueRefresh = new Promise<void>((resolve) => (release = resolve));
    const { root, service } = await fixture({
      syncer: {
        async status() {
          started();
          await continueRefresh;
          return "synchronized";
        },
        async sync(path) {
          return {
            headCommit: execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: path,
              encoding: "utf8",
            }).trim(),
          };
        },
      },
    });
    const repository = createGitRepository(root, "project");
    const workspace = await service.create({
      path: repository,
      name: "Project",
    });

    const refreshing = service.refresh(workspace.id);
    await refreshStarted;
    expect(() => service.remove(workspace.id)).toThrow(
      expect.objectContaining({ code: "GIT_OPERATION_BUSY" }),
    );
    release();
    await expect(refreshing).resolves.toMatchObject({ id: workspace.id });
  });

  it("refreshes independent repositories with bounded concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    let release!: () => void;
    const continueRefresh = new Promise<void>((resolve) => (release = resolve));
    const { root, service } = await fixture({
      syncer: {
        async status() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await continueRefresh;
          active -= 1;
          return "synchronized";
        },
        async sync(path) {
          return {
            headCommit: execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: path,
              encoding: "utf8",
            }).trim(),
          };
        },
      },
    });
    for (let index = 1; index <= 4; index += 1) {
      await service.create({
        path: createGitRepository(root, `project-${index}`),
        name: `Project ${index}`,
      });
    }

    const refreshing = service.refreshAll();
    await vi.waitFor(() => expect(maximumActive).toBe(3));
    release();
    await refreshing;
    expect(maximumActive).toBe(3);
  });

  it("blocks removal when future managed worktree rows exist", async () => {
    const { root, database, service } = await fixture();
    const repository = createGitRepository(root, "project");
    const created = await service.create({ path: repository, name: "Project" });
    database.sqlite
      .prepare(
        `
        INSERT INTO worktrees (
          id, workspace_id, name, slug, path, branch_ref, base_ref, base_commit,
          lifecycle, health, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'healthy', ?, ?)
      `,
      )
      .run(
        "worktree-1",
        created.id,
        "Feature",
        "feature",
        `${root}/managed-feature`,
        "refs/heads/pi-dash/feature",
        "HEAD",
        "a".repeat(40),
        "2026-02-03T04:05:06.000Z",
        "2026-02-03T04:05:06.000Z",
      );

    expect(service.get(created.id).worktreeCount).toBe(1);
    expect(() => service.remove(created.id)).toThrow(
      expect.objectContaining({ code: "WORKSPACE_HAS_WORKTREES" }),
    );
  });
});
