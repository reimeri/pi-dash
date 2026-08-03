import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorktreePorcelain } from "../src/git/git-worktree-manager.js";
import { createBaseSnapshotSigner } from "../src/worktrees/base-snapshot.js";
import {
  mountedPathsWithin,
  purgeQuarantinedPath,
} from "../src/worktrees/managed-path-removal.js";
import { createRemovalConfirmationSigner } from "../src/worktrees/removal-confirmation.js";
import {
  createGitMutationLock,
  GitMutationBusyError,
} from "../src/worktrees/git-mutation-lock.js";
import {
  allocateWorktreePath,
  deriveBranchRef,
  normalizeWorktreeName,
  validateWorktreeSlug,
  worktreeSlugBase,
} from "../src/worktrees/worktree-validation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("worktree foundations", () => {
  it("normalizes names and validates safe branch/path components", () => {
    expect(normalizeWorktreeName("  OAuth   refresh  ")).toBe("OAuth refresh");
    expect(worktreeSlugBase("Crème brûlée / OAuth")).toBe("creme-brulee-oauth");
    expect(validateWorktreeSlug("oauth-refresh")).toBe("oauth-refresh");
    expect(deriveBranchRef("oauth-refresh")).toBe(
      "refs/heads/pi-dash/oauth-refresh",
    );
    expect(() => validateWorktreeSlug("../escape")).toThrow();
    expect(() => validateWorktreeSlug("bad\u0000name")).toThrow();

    const root = mkdtempSync(join(tmpdir(), "pi-dash-paths-"));
    roots.push(root);
    const allocated = allocateWorktreePath(
      root,
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "unicode-safe",
    );
    expect(allocated.path.startsWith(root)).toBe(true);
    expect(allocated.path).toContain("22222222-2222-4222-8222-222222222222");
  });

  it("parses NUL-delimited porcelain including detached and locked worktrees", () => {
    expect(() =>
      parseWorktreePorcelain(
        ["worktree /invalid", `HEAD ${"a".repeat(41)}`, "", ""].join("\0"),
      ),
    ).toThrow("Malformed worktree HEAD");
    expect(
      parseWorktreePorcelain(
        [
          "worktree /repo with spaces",
          `HEAD ${"a".repeat(40)}`,
          "branch refs/heads/main",
          "",
          "worktree /linked",
          `HEAD ${"b".repeat(40)}`,
          "detached",
          "locked reason",
          "",
          "",
        ].join("\0"),
      ),
    ).toEqual([
      {
        path: "/repo with spaces",
        head: "a".repeat(40),
        branchRef: "refs/heads/main",
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null,
      },
      {
        path: "/linked",
        head: "b".repeat(40),
        branchRef: null,
        detached: true,
        locked: true,
        lockReason: "reason",
        prunable: false,
        prunableReason: null,
      },
    ]);
  });

  it("binds destructive confirmation tokens to the inspected state", () => {
    let instant = new Date("2026-01-01T00:00:00Z");
    const signer = createRemovalConfirmationSigner({
      key: Buffer.alloc(32, 4),
      now: () => instant,
      ttlMs: 1_000,
    });
    const expected = {
      worktreeId: "worktree",
      recordUpdatedAt: "2026-01-01T00:00:00.000Z",
      inspectionHash: "a".repeat(64),
    };
    const confirmation = signer.sign(expected);
    expect(signer.verify(confirmation.token, expected)).toBe(true);
    expect(
      signer.verify(confirmation.token, {
        ...expected,
        inspectionHash: "b".repeat(64),
      }),
    ).toBe(false);
    instant = new Date("2026-01-01T00:00:02Z");
    expect(signer.verify(confirmation.token, expected)).toBe(false);
  });

  it("refuses to purge replacement data at a journaled quarantine path", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-quarantine-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const trashRoot = join(workspaceRoot, ".pi-dash-trash");
    const operationId = "11111111-1111-4111-8111-111111111111";
    const quarantinePath = join(trashRoot, operationId);
    const movedAside = join(trashRoot, "original-data");
    mkdirSync(quarantinePath, { recursive: true });
    writeFileSync(join(quarantinePath, "original.txt"), "original\n");
    const original = lstatSync(quarantinePath, { bigint: true });
    renameSync(quarantinePath, movedAside);
    mkdirSync(quarantinePath);
    writeFileSync(join(quarantinePath, "replacement.txt"), "replacement\n");

    await expect(
      purgeQuarantinedPath({
        path: quarantinePath,
        workspaceRoot,
        operationId,
        expectedIdentity: {
          device: original.dev.toString(),
          inode: original.ino.toString(),
          kind: "directory",
        },
      }),
    ).rejects.toThrow("Quarantine identity changed");
    expect(existsSync(join(quarantinePath, "replacement.txt"))).toBe(true);
    expect(existsSync(join(movedAside, "original.txt"))).toBe(true);
  });

  it("treats a mounted deletion root as mounted content", async () => {
    if (process.platform !== "linux") return;
    expect(await mountedPathsWithin("/")).toContain("/");
  });

  it("binds signed snapshots and rejects expiry or changed input", () => {
    let instant = new Date("2026-01-01T00:00:00Z");
    const signer = createBaseSnapshotSigner({
      key: Buffer.alloc(32, 3),
      now: () => instant,
      ttlMs: 1_000,
    });
    const snapshot = signer.sign(
      "workspace",
      "refs/heads/main",
      "a".repeat(40),
    );
    expect(
      signer.verify(snapshot.token, {
        workspaceId: "workspace",
        ref: "refs/heads/main",
        commit: "a".repeat(40),
      }),
    ).toBe(true);
    expect(
      signer.verify(snapshot.token, {
        workspaceId: "workspace",
        ref: "refs/heads/main",
        commit: "b".repeat(40),
      }),
    ).toBe(false);
    instant = new Date("2026-01-01T00:00:02Z");
    expect(
      signer.verify(snapshot.token, {
        workspaceId: "workspace",
        ref: "refs/heads/main",
        commit: "a".repeat(40),
      }),
    ).toBe(false);
  });

  it("refuses overlapping mutations for one canonical common directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-locks-"));
    roots.push(root);
    const lockRoot = join(root, "locks");
    const commonDir = join(root, "common");
    mkdirSync(lockRoot, { mode: 0o700 });
    mkdirSync(commonDir);
    const lock = createGitMutationLock({ root: lockRoot });
    const competingLock = createGitMutationLock({ root: lockRoot });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const first = lock.runExclusive(commonDir, () => waiting);
    await expect(
      competingLock.runExclusive(commonDir, async () => undefined),
    ).rejects.toBeInstanceOf(GitMutationBusyError);
    release();
    await first;
  });
});
