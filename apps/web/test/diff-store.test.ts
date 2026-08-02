import type { WorktreeDiff, WorktreeDiffSummary } from "@pi-dash/contracts";
import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeDiffStore } from "../src/lib/diff/store.js";

const WORKTREE_A = "2cb84366-6fb7-4a60-b15e-6726381b190c";
const WORKTREE_B = "3cb84366-6fb7-4a60-b15e-6726381b190d";

function summary(worktreeId: string, additions = 1): WorktreeDiffSummary {
  return {
    worktreeId,
    headCommit: "a".repeat(40),
    snapshotId: additions.toString(16).padStart(64, "0"),
    hasChanges: additions > 0,
    filesChanged: additions > 0 ? 1 : 0,
    additions,
    deletions: 0,
    binaryFiles: 0,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
}

function diff(worktreeId: string): WorktreeDiff {
  return {
    ...summary(worktreeId, 2),
    patch: "diff --git a/file.ts b/file.ts\n",
    truncated: false,
    omittedFiles: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => (resolve = next));
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("worktree diff store", () => {
  it("switches from cheap summary polling to full snapshots while open", async () => {
    const client = {
      worktreeDiffSummary: vi.fn(async () => summary(WORKTREE_A)),
      worktreeDiff: vi.fn(async () => diff(WORKTREE_A)),
    };
    const store = createWorktreeDiffStore(client, { pollMs: 60_000 });
    store.select(WORKTREE_A);
    await vi.waitFor(() =>
      expect(client.worktreeDiffSummary).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(get(store).status).toBe("ready"));

    store.setOpen(true);
    await vi.waitFor(() => expect(client.worktreeDiff).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(get(store).diff?.additions).toBe(2));
    expect(get(store).summary?.additions).toBe(2);

    store.setOpen(false);
    await vi.waitFor(() =>
      expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(get(store).diff).toBeUndefined());
    store.destroy();
  });

  it("ignores stale responses after the selected worktree changes", async () => {
    const first = deferred<WorktreeDiffSummary>();
    const client = {
      worktreeDiffSummary: vi.fn((id: string) =>
        id === WORKTREE_A ? first.promise : Promise.resolve(summary(id, 3)),
      ),
      worktreeDiff: vi.fn(async (id: string) => diff(id)),
    };
    const store = createWorktreeDiffStore(client, { pollMs: 60_000 });
    store.select(WORKTREE_A);
    await vi.waitFor(() =>
      expect(client.worktreeDiffSummary).toHaveBeenCalledOnce(),
    );
    store.select(WORKTREE_B);
    first.resolve(summary(WORKTREE_A, 9));
    await vi.waitFor(() =>
      expect(get(store).summary?.worktreeId).toBe(WORKTREE_B),
    );

    expect(get(store).summary?.worktreeId).toBe(WORKTREE_B);
    expect(get(store).summary?.additions).toBe(3);
    store.destroy();
  });

  it("does not overlap polling requests", async () => {
    vi.useFakeTimers();
    const first = deferred<WorktreeDiffSummary>();
    const client = {
      worktreeDiffSummary: vi
        .fn<() => Promise<WorktreeDiffSummary>>()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(summary(WORKTREE_A, 2)),
      worktreeDiff: vi.fn(async () => diff(WORKTREE_A)),
    };
    const store = createWorktreeDiffStore(client, { pollMs: 2_000 });
    store.select(WORKTREE_A);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.worktreeDiffSummary).toHaveBeenCalledOnce();

    first.resolve(summary(WORKTREE_A));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(client.worktreeDiffSummary).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(2);
    store.destroy();
  });
});
