import type { WorktreeDiff, WorktreeDiffSummary } from "@pi-dash/contracts";
import { writable } from "svelte/store";

export interface WorktreeDiffClient {
  worktreeDiffSummary(
    worktreeId: string,
    signal?: AbortSignal,
  ): Promise<WorktreeDiffSummary>;
  worktreeDiff(worktreeId: string, signal?: AbortSignal): Promise<WorktreeDiff>;
}

interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export function createCoordinatedWorktreeDiffClient(
  client: WorktreeDiffClient,
): WorktreeDiffClient {
  type Release = () => void;
  const pendingByWorktree = new Map<string, Promise<unknown>>();
  const capacityWaiters: Array<(release: Release) => void> = [];
  let activeCount = 0;

  function acquire(): Promise<Release> {
    if (activeCount < 4) {
      activeCount += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => capacityWaiters.push(resolve));
  }

  function release(): void {
    const next = capacityWaiters.shift();
    if (next) next(release);
    else activeCount -= 1;
  }

  function run<T>(
    worktreeId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const abortError = () =>
      new DOMException("The operation was aborted", "AbortError");
    if (signal?.aborted) return Promise.reject(abortError());

    const previous = pendingByWorktree.get(worktreeId) ?? Promise.resolve();
    const request = previous
      .catch(() => undefined)
      .then(async () => {
        if (signal?.aborted) throw abortError();
        const releaseCapacity = await acquire();
        try {
          if (signal?.aborted) throw abortError();
          return await operation();
        } finally {
          releaseCapacity();
        }
      });
    pendingByWorktree.set(worktreeId, request);
    const cleanup = (): void => {
      if (pendingByWorktree.get(worktreeId) === request) {
        pendingByWorktree.delete(worktreeId);
      }
    };
    void request.then(cleanup, cleanup);
    if (!signal) return request;

    return new Promise<T>((resolve, reject) => {
      const handleAbort = () => reject(abortError());
      signal.addEventListener("abort", handleAbort, { once: true });
      void request.then(
        (value) => {
          signal.removeEventListener("abort", handleAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", handleAbort);
          reject(error);
        },
      );
    });
  }

  return {
    worktreeDiffSummary: (worktreeId, signal) =>
      run(worktreeId, signal, () => client.worktreeDiffSummary(worktreeId)),
    worktreeDiff: (worktreeId, signal) =>
      run(worktreeId, signal, () => client.worktreeDiff(worktreeId)),
  };
}

export interface WorktreeDiffState {
  worktreeId?: string;
  open: boolean;
  status: "idle" | "loading" | "ready" | "error";
  refreshing: boolean;
  summary?: WorktreeDiffSummary;
  diff?: WorktreeDiff;
  message: string;
}

const initialState: WorktreeDiffState = {
  open: false,
  status: "idle",
  refreshing: false,
  message: "",
};

function summaryFromDiff(diff: WorktreeDiff): WorktreeDiffSummary {
  return {
    worktreeId: diff.worktreeId,
    headCommit: diff.headCommit,
    snapshotId: diff.snapshotId,
    hasChanges: diff.hasChanges,
    filesChanged: diff.filesChanged,
    additions: diff.additions,
    deletions: diff.deletions,
    binaryFiles: diff.binaryFiles,
    checkedAt: diff.checkedAt,
  };
}

export function createWorktreeDiffStore(
  client: WorktreeDiffClient,
  options: {
    pollMs?: number;
    visibility?: VisibilitySource;
  } = {},
) {
  const pollMs = options.pollMs ?? 2_000;
  const visibility =
    options.visibility ??
    (typeof document === "undefined" ? undefined : document);
  const { subscribe, update, set } = writable<WorktreeDiffState>(initialState);
  let current = initialState;
  const unsubscribe = subscribe((state) => (current = state));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let requestToken = 0;
  let failures = 0;
  let restartPending = false;
  let destroyed = false;

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(delay: number): void {
    clearTimer();
    if (destroyed || !current.worktreeId || visibility?.hidden) return;
    timer = setTimeout(() => void inspect(), delay);
  }

  async function inspect(): Promise<void> {
    const worktreeId = current.worktreeId;
    if (destroyed || !worktreeId || visibility?.hidden || controller) return;
    const token = ++requestToken;
    const requestController = new AbortController();
    controller = requestController;
    update((state) => ({
      ...state,
      status: state.summary ? state.status : "loading",
      refreshing: !!state.summary,
      message: "",
    }));
    try {
      if (current.open) {
        const diff = await client.worktreeDiff(
          worktreeId,
          requestController.signal,
        );
        if (token !== requestToken || current.worktreeId !== worktreeId) return;
        failures = 0;
        update((state) => ({
          ...state,
          status: "ready",
          refreshing: false,
          summary: summaryFromDiff(diff),
          diff,
          message: "",
        }));
      } else {
        const summary = await client.worktreeDiffSummary(
          worktreeId,
          requestController.signal,
        );
        if (token !== requestToken || current.worktreeId !== worktreeId) return;
        failures = 0;
        update((state) => ({
          ...state,
          status: "ready",
          refreshing: false,
          summary,
          diff: undefined,
          message: "",
        }));
      }
    } catch (error) {
      if (
        token !== requestToken ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      failures += 1;
      update((state) => ({
        ...state,
        status: "error",
        refreshing: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to inspect worktree changes.",
      }));
    } finally {
      if (controller === requestController) controller = undefined;
      if (!destroyed) {
        if (restartPending) {
          restartPending = false;
          void inspect();
        } else if (token === requestToken) {
          const delay = failures
            ? Math.min(30_000, pollMs * 2 ** Math.min(failures, 4))
            : pollMs;
          schedule(delay);
        }
      }
    }
  }

  function restart(): void {
    clearTimer();
    requestToken += 1;
    if (controller) {
      restartPending = true;
      controller.abort();
      return;
    }
    void inspect();
  }

  function select(worktreeId: string | undefined): void {
    if (current.worktreeId === worktreeId) return;
    requestToken += 1;
    restartPending = false;
    const activeController = controller;
    activeController?.abort();
    clearTimer();
    failures = 0;
    set(
      worktreeId
        ? {
            worktreeId,
            open: false,
            status: "loading",
            refreshing: false,
            message: "",
          }
        : initialState,
    );
    if (worktreeId) {
      if (activeController) restartPending = true;
      else void inspect();
    }
  }

  function setOpen(open: boolean): void {
    if (!current.worktreeId || current.open === open) return;
    update((state) => ({ ...state, open }));
    restart();
  }

  function refresh(): void {
    if (current.worktreeId) restart();
  }

  const handleVisibility = (): void => {
    if (!visibility?.hidden && current.worktreeId) restart();
    else clearTimer();
  };
  visibility?.addEventListener("visibilitychange", handleVisibility);

  return {
    subscribe,
    select,
    setOpen,
    refresh,
    destroy() {
      destroyed = true;
      requestToken += 1;
      restartPending = false;
      controller?.abort();
      clearTimer();
      visibility?.removeEventListener("visibilitychange", handleVisibility);
      unsubscribe();
    },
  };
}

export function createWorktreeDiffSummaryStore(
  client: Pick<WorktreeDiffClient, "worktreeDiffSummary">,
  options: {
    pollMs?: number;
    visibility?: VisibilitySource;
  } = {},
) {
  const pollMs = options.pollMs ?? 2_000;
  const visibility =
    options.visibility ??
    (typeof document === "undefined" ? undefined : document);
  const { subscribe, update, set } = writable<
    Record<string, WorktreeDiffSummary>
  >({});
  let worktreeIds: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let destroyed = false;
  const failureCounts = new Map<string, number>();
  const retryAfter = new Map<string, number>();

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(): void {
    clearTimer();
    if (destroyed || worktreeIds.length === 0 || visibility?.hidden) return;
    timer = setTimeout(() => void inspect(), pollMs);
  }

  async function inspect(): Promise<void> {
    if (
      destroyed ||
      worktreeIds.length === 0 ||
      visibility?.hidden ||
      controller
    ) {
      return;
    }
    const requestGeneration = generation;
    const now = Date.now();
    const requestedIds = worktreeIds.filter(
      (worktreeId) => (retryAfter.get(worktreeId) ?? 0) <= now,
    );
    const requestController = new AbortController();
    controller = requestController;
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (nextIndex < requestedIds.length) {
        if (destroyed || requestGeneration !== generation) return;
        const worktreeId = requestedIds[nextIndex++];
        if (!worktreeId) return;
        try {
          const summary = await client.worktreeDiffSummary(
            worktreeId,
            requestController.signal,
          );
          if (
            destroyed ||
            requestGeneration !== generation ||
            requestController.signal.aborted ||
            summary.worktreeId !== worktreeId
          ) {
            continue;
          }
          failureCounts.delete(worktreeId);
          retryAfter.delete(worktreeId);
          update((summaries) => ({ ...summaries, [worktreeId]: summary }));
        } catch {
          if (
            destroyed ||
            requestGeneration !== generation ||
            requestController.signal.aborted
          ) {
            continue;
          }
          const failures = (failureCounts.get(worktreeId) ?? 0) + 1;
          failureCounts.set(worktreeId, failures);
          retryAfter.set(
            worktreeId,
            Date.now() + pollMs * 2 ** Math.min(failures - 1, 4),
          );
          update((summaries) => {
            const next = { ...summaries };
            delete next[worktreeId];
            return next;
          });
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(3, requestedIds.length) }, async () =>
        worker(),
      ),
    );
    if (controller === requestController) controller = undefined;
    if (!destroyed && requestGeneration === generation) schedule();
  }

  function track(ids: string[]): void {
    const nextIds = [...new Set(ids)].sort();
    if (
      nextIds.length === worktreeIds.length &&
      nextIds.every((id, index) => id === worktreeIds[index])
    ) {
      return;
    }

    generation += 1;
    worktreeIds = nextIds;
    clearTimer();
    const activeController = controller;
    controller = undefined;
    activeController?.abort();
    for (const worktreeId of [...failureCounts.keys()]) {
      if (!worktreeIds.includes(worktreeId)) {
        failureCounts.delete(worktreeId);
        retryAfter.delete(worktreeId);
      }
    }
    update((summaries) =>
      Object.fromEntries(
        Object.entries(summaries).filter(([worktreeId]) =>
          worktreeIds.includes(worktreeId),
        ),
      ),
    );
    if (worktreeIds.length > 0 && !visibility?.hidden) void inspect();
  }

  const handleVisibility = (): void => {
    if (!visibility?.hidden && worktreeIds.length > 0) {
      clearTimer();
      if (!controller) void inspect();
    } else {
      clearTimer();
    }
  };
  visibility?.addEventListener("visibilitychange", handleVisibility);

  return {
    subscribe,
    track,
    destroy() {
      destroyed = true;
      generation += 1;
      controller?.abort();
      controller = undefined;
      clearTimer();
      failureCounts.clear();
      retryAfter.clear();
      set({});
      visibility?.removeEventListener("visibilitychange", handleVisibility);
    },
  };
}
