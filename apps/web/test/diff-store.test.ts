import type { WorktreeDiff, WorktreeDiffSummary } from "@pi-dash/contracts";
import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCoordinatedWorktreeDiffClient,
  createWorktreeDiffStore,
  createWorktreeDiffSummaryStore,
  syncSidebarDiffSummaries,
} from "../src/lib/diff/store.js";

const WORKTREE_A = "2cb84366-6fb7-4a60-b15e-6726381b190c";
const WORKTREE_B = "3cb84366-6fb7-4a60-b15e-6726381b190d";
const WORKTREE_C = "4cb84366-6fb7-4a60-b15e-6726381b190e";
const WORKTREE_D = "5cb84366-6fb7-4a60-b15e-6726381b190f";
const WORKTREE_E = "6cb84366-6fb7-4a60-b15e-6726381b1910";

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

describe("coordinated worktree diff client", () => {
  it("waits for an active sidebar summary before inspecting the selected diff", async () => {
    const activeSummary = deferred<WorktreeDiffSummary>();
    const client = {
      worktreeDiffSummary: vi.fn(async () => activeSummary.promise),
      worktreeDiff: vi.fn(async (id: string) => diff(id)),
    };
    const coordinated = createCoordinatedWorktreeDiffClient(client);

    const summaryRequest = coordinated.worktreeDiffSummary(WORKTREE_A);
    const diffRequest = coordinated.worktreeDiff(WORKTREE_A);
    await Promise.resolve();
    expect(client.worktreeDiff).not.toHaveBeenCalled();

    activeSummary.resolve(summary(WORKTREE_A));
    await expect(summaryRequest).resolves.toMatchObject({
      worktreeId: WORKTREE_A,
    });
    await expect(diffRequest).resolves.toMatchObject({
      worktreeId: WORKTREE_A,
    });
    expect(client.worktreeDiff).toHaveBeenCalledOnce();
  });

  it("releases an aborted queued selection without breaking serialization", async () => {
    const activeSummary = deferred<WorktreeDiffSummary>();
    const client = {
      worktreeDiffSummary: vi.fn((id: string) =>
        id === WORKTREE_A
          ? activeSummary.promise
          : Promise.resolve(summary(id, 4)),
      ),
      worktreeDiff: vi.fn(async (id: string) => diff(id)),
    };
    const coordinated = createCoordinatedWorktreeDiffClient(client);
    const sidebarRequest = coordinated.worktreeDiffSummary(WORKTREE_A);
    const store = createWorktreeDiffStore(coordinated, { pollMs: 60_000 });

    store.select(WORKTREE_A);
    await Promise.resolve();
    store.select(WORKTREE_B);
    await vi.waitFor(() =>
      expect(get(store).summary?.worktreeId).toBe(WORKTREE_B),
    );

    expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(2);
    activeSummary.resolve(summary(WORKTREE_A));
    await expect(sidebarRequest).resolves.toMatchObject({
      worktreeId: WORKTREE_A,
    });
    store.destroy();
  });
});

describe("worktree diff summary store", () => {
  it("preserves counts while polling ownership moves to and from the selected worktree", async () => {
    const refreshedSummary = deferred<WorktreeDiffSummary>();
    let worktreeACalls = 0;
    const client = {
      worktreeDiffSummary: vi.fn((id: string) => {
        if (id !== WORKTREE_A) return Promise.resolve(summary(id, 3));
        worktreeACalls += 1;
        return worktreeACalls === 1
          ? Promise.resolve(summary(id, 2))
          : refreshedSummary.promise;
      }),
    };
    const store = createWorktreeDiffSummaryStore(client, { pollMs: 60_000 });

    syncSidebarDiffSummaries(
      store,
      [WORKTREE_A, WORKTREE_B],
      undefined,
      undefined,
    );
    await vi.waitFor(() => expect(get(store)[WORKTREE_A]?.additions).toBe(2));

    syncSidebarDiffSummaries(
      store,
      [WORKTREE_A, WORKTREE_B],
      WORKTREE_A,
      undefined,
    );
    expect(get(store)[WORKTREE_A]?.additions).toBe(2);
    syncSidebarDiffSummaries(
      store,
      [WORKTREE_A, WORKTREE_B],
      WORKTREE_A,
      summary(WORKTREE_A, 5),
    );
    expect(get(store)[WORKTREE_A]?.additions).toBe(5);

    syncSidebarDiffSummaries(
      store,
      [WORKTREE_A, WORKTREE_B],
      WORKTREE_B,
      summary(WORKTREE_A, 5),
    );
    syncSidebarDiffSummaries(
      store,
      [WORKTREE_A, WORKTREE_B],
      WORKTREE_B,
      undefined,
    );
    expect(get(store)[WORKTREE_A]?.additions).toBe(5);
    refreshedSummary.resolve(summary(WORKTREE_A, 6));
    await vi.waitFor(() => expect(get(store)[WORKTREE_A]?.additions).toBe(6));
    store.destroy();
  });

  it("loads newly tracked worktrees before stale inspections settle", async () => {
    const staleSummary = deferred<WorktreeDiffSummary>();
    const client = {
      worktreeDiffSummary: vi.fn((id: string) =>
        id === WORKTREE_A
          ? staleSummary.promise
          : Promise.resolve(summary(id, 4)),
      ),
      worktreeDiff: vi.fn(async (id: string) => diff(id)),
    };
    const coordinated = createCoordinatedWorktreeDiffClient(client);
    const store = createWorktreeDiffSummaryStore(coordinated, {
      pollMs: 60_000,
    });

    store.track([WORKTREE_A]);
    await vi.waitFor(() =>
      expect(client.worktreeDiffSummary).toHaveBeenCalledOnce(),
    );
    store.track([WORKTREE_B]);
    await vi.waitFor(() => expect(get(store)[WORKTREE_B]?.additions).toBe(4));

    expect(get(store)[WORKTREE_A]).toBeUndefined();
    staleSummary.resolve(summary(WORKTREE_A));
    store.destroy();
  });

  it("polls every tracked worktree and keeps its latest summary", async () => {
    vi.useFakeTimers();
    const client = {
      worktreeDiffSummary: vi.fn(async (id: string) =>
        summary(id, id === WORKTREE_A ? 2 : 3),
      ),
    };
    const store = createWorktreeDiffSummaryStore(client, { pollMs: 2_000 });

    store.track([WORKTREE_A, WORKTREE_B]);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(2);
    expect(get(store)[WORKTREE_A]?.additions).toBe(2);
    expect(get(store)[WORKTREE_B]?.additions).toBe(3);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(4);
    store.destroy();
  });

  it("limits concurrent inspections to leave capacity for the selected diff", async () => {
    let active = 0;
    let maxActive = 0;
    const pending: Array<{
      id: string;
      resolve: (value: WorktreeDiffSummary) => void;
    }> = [];
    const client = {
      worktreeDiffSummary: vi.fn(
        (id: string) =>
          new Promise<WorktreeDiffSummary>((resolve) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            pending.push({
              id,
              resolve(value) {
                active -= 1;
                resolve(value);
              },
            });
          }),
      ),
    };
    const store = createWorktreeDiffSummaryStore(client, { pollMs: 60_000 });

    store.track([WORKTREE_A, WORKTREE_B, WORKTREE_C, WORKTREE_D, WORKTREE_E]);
    await vi.waitFor(() =>
      expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(3),
    );
    pending[0]?.resolve(summary(pending[0].id));
    await vi.waitFor(() =>
      expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(4),
    );
    pending[1]?.resolve(summary(pending[1].id));
    await vi.waitFor(() =>
      expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(5),
    );
    pending.slice(2).forEach((request) => request.resolve(summary(request.id)));
    await vi.waitFor(() => expect(active).toBe(0));

    expect(maxActive).toBe(3);
    store.destroy();
  });

  it("hides a failed summary and retries it with backoff", async () => {
    vi.useFakeTimers();
    const client = {
      worktreeDiffSummary: vi
        .fn<(id: string) => Promise<WorktreeDiffSummary>>()
        .mockResolvedValueOnce(summary(WORKTREE_A, 2))
        .mockRejectedValueOnce(new Error("busy"))
        .mockResolvedValue(summary(WORKTREE_A, 5)),
    };
    const store = createWorktreeDiffSummaryStore(client, { pollMs: 2_000 });

    store.track([WORKTREE_A]);
    await vi.advanceTimersByTimeAsync(0);
    expect(get(store)[WORKTREE_A]?.additions).toBe(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(get(store)[WORKTREE_A]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(client.worktreeDiffSummary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(get(store)[WORKTREE_A]?.additions).toBe(5);
    store.destroy();
  });

  it("drops untracked summaries and ignores their stale responses", async () => {
    const first = deferred<WorktreeDiffSummary>();
    const client = {
      worktreeDiffSummary: vi.fn((id: string) =>
        id === WORKTREE_A ? first.promise : Promise.resolve(summary(id, 4)),
      ),
    };
    const store = createWorktreeDiffSummaryStore(client, { pollMs: 60_000 });

    store.track([WORKTREE_A]);
    await vi.waitFor(() =>
      expect(client.worktreeDiffSummary).toHaveBeenCalledOnce(),
    );
    store.track([WORKTREE_B]);
    first.resolve(summary(WORKTREE_A, 9));
    await vi.waitFor(() => expect(get(store)[WORKTREE_B]?.additions).toBe(4));

    expect(get(store)[WORKTREE_A]).toBeUndefined();
    store.setSummary(summary(WORKTREE_A, 10));
    expect(get(store)[WORKTREE_A]).toBeUndefined();
    store.destroy();
  });
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
