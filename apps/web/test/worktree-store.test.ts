import type { WorktreeDto } from "@pi-dash/contracts";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { createWorktreeStore } from "../src/lib/worktrees/store.js";

const worktree: WorktreeDto = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  name: "Feature",
  slug: "feature",
  path: "/managed/feature",
  branchRef: "refs/heads/pi-dash/feature",
  baseRef: "refs/heads/main",
  baseCommit: "a".repeat(40),
  lifecycle: "removed",
  finalBranchTip: "a".repeat(40),
  health: "missing",
  dirty: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("worktree store", () => {
  it("forwards cancellation to worktree loads", async () => {
    const worktrees = vi.fn(async () => ({ worktrees: [] }));
    const store = createWorktreeStore({
      worktrees,
      reconcileWorktrees: async () => ({ worktrees: [] }),
    });
    const signal = AbortSignal.abort();
    await store.load(worktree.workspaceId, signal);
    expect(worktrees).toHaveBeenCalledWith(worktree.workspaceId, signal);
  });

  it("tracks concurrent workspace loads and failures independently", async () => {
    let resolveFirst!: (value: { worktrees: [] }) => void;
    let rejectSecond!: (error: Error) => void;
    const firstResponse = new Promise<{ worktrees: [] }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise<{ worktrees: [] }>(
      (_resolve, reject) => {
        rejectSecond = reject;
      },
    );
    const store = createWorktreeStore({
      worktrees: (workspaceId) =>
        workspaceId === "first" ? firstResponse : secondResponse,
      reconcileWorktrees: async () => ({ worktrees: [] }),
    });

    const firstLoad = store.load("first");
    const secondLoad = store.load("second");
    expect(get(store).loadingByWorkspace).toEqual({
      first: true,
      second: true,
    });

    resolveFirst({ worktrees: [] });
    await firstLoad;
    expect(get(store).loadingByWorkspace).toEqual({
      first: false,
      second: true,
    });

    rejectSecond(new Error("second workspace failed"));
    await secondLoad;
    expect(get(store)).toMatchObject({
      loadingByWorkspace: { first: false, second: false },
      errorsByWorkspace: { second: "second workspace failed" },
    });
  });

  it("does not restore a deleted worktree from an older pending reconciliation", async () => {
    let resolveReconcile!: (value: { worktrees: WorktreeDto[] }) => void;
    const response = new Promise<{ worktrees: WorktreeDto[] }>((resolve) => {
      resolveReconcile = resolve;
    });
    const store = createWorktreeStore({
      worktrees: async () => ({ worktrees: [] }),
      reconcileWorktrees: async () => response,
    });
    store.upsert(worktree);

    const reconciliation = store.reconcile(worktree.workspaceId);
    store.remove(worktree.workspaceId, worktree.id);
    resolveReconcile({ worktrees: [worktree] });
    await reconciliation;

    expect(get(store).byWorkspace[worktree.workspaceId]).toEqual([]);
  });

  it("does not restore a deleted workspace from an older pending load", async () => {
    let resolveLoad!: (value: { worktrees: WorktreeDto[] }) => void;
    const response = new Promise<{ worktrees: WorktreeDto[] }>((resolve) => {
      resolveLoad = resolve;
    });
    const store = createWorktreeStore({
      worktrees: async () => response,
      reconcileWorktrees: async () => ({ worktrees: [] }),
    });

    const load = store.load(worktree.workspaceId);
    store.clearWorkspace(worktree.workspaceId);
    resolveLoad({ worktrees: [worktree] });
    await load;

    expect(get(store).byWorkspace[worktree.workspaceId]).toBeUndefined();
  });

  it("does not restore a deleted worktree from an older pending load", async () => {
    let resolveLoad!: (value: { worktrees: WorktreeDto[] }) => void;
    const response = new Promise<{ worktrees: WorktreeDto[] }>((resolve) => {
      resolveLoad = resolve;
    });
    const store = createWorktreeStore({
      worktrees: async () => response,
      reconcileWorktrees: async () => ({ worktrees: [] }),
    });
    store.upsert(worktree);

    const load = store.load(worktree.workspaceId);
    store.remove(worktree.workspaceId, worktree.id);
    resolveLoad({ worktrees: [worktree] });
    await load;

    expect(get(store).byWorkspace[worktree.workspaceId]).toEqual([]);
  });
});
