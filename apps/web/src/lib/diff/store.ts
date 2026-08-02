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
