import type {
  ApplicationEventsServerFrame,
  RuntimeDto,
  ShellActivityDto,
  WorkflowStatusDto,
  WorkspaceAttentionDto,
} from "@pi-dash/contracts";
import { writable } from "svelte/store";

export type StatusChannelState = "connecting" | "connected" | "disconnected";

export interface WorkflowStatusState {
  cursor: number;
  snapshotReceived: boolean;
  channel: StatusChannelState;
  byWorktree: Record<string, WorkflowStatusDto>;
  runtimes: Record<string, RuntimeDto>;
  shellActivities: Record<string, ShellActivityDto>;
  workspaceAttention: WorkspaceAttentionDto[];
}

export const initialWorkflowStatusState: WorkflowStatusState = {
  cursor: 0,
  snapshotReceived: false,
  channel: "connecting",
  byWorktree: {},
  runtimes: {},
  shellActivities: {},
  workspaceAttention: [],
};

export function reduceWorkflowStatusState(
  state: WorkflowStatusState,
  frame: ApplicationEventsServerFrame,
): { state: WorkflowStatusState; resyncRequired: boolean } {
  if (frame.type === "resyncRequired") {
    return { state, resyncRequired: true };
  }
  if (frame.type === "snapshot") {
    return {
      resyncRequired: false,
      state: {
        cursor: frame.cursor,
        snapshotReceived: true,
        channel: "connected",
        byWorktree: Object.fromEntries(
          frame.statuses.map((status) => [status.worktreeId, status]),
        ),
        runtimes: Object.fromEntries(
          frame.runtimes.map((runtime) => [runtime.worktreeId, runtime]),
        ),
        shellActivities: Object.fromEntries(
          frame.shellActivities.map((activity) => [
            activity.worktreeId,
            activity,
          ]),
        ),
        workspaceAttention: frame.workspaceAttention,
      },
    };
  }
  if (!state.snapshotReceived || frame.cursor !== state.cursor + 1) {
    return { state, resyncRequired: true };
  }
  if (frame.type === "shellActivity") {
    const current = state.shellActivities[frame.activity.worktreeId];
    if (
      current?.runtimeId &&
      frame.activity.runtimeId &&
      current.runtimeId !== frame.activity.runtimeId &&
      current.changedAt > frame.activity.changedAt
    ) {
      return {
        resyncRequired: false,
        state: { ...state, cursor: frame.cursor },
      };
    }
    return {
      resyncRequired: false,
      state: {
        ...state,
        cursor: frame.cursor,
        shellActivities: {
          ...state.shellActivities,
          [frame.activity.worktreeId]: frame.activity,
        },
      },
    };
  }
  if (frame.type === "status") {
    return {
      resyncRequired: false,
      state: {
        ...state,
        cursor: frame.cursor,
        byWorktree: {
          ...state.byWorktree,
          [frame.status.worktreeId]: frame.status,
        },
        workspaceAttention: frame.workspaceAttention,
      },
    };
  }
  if (
    frame.type === "workspaceUpdated" ||
    frame.type === "workspaceOrderUpdated"
  ) {
    return {
      resyncRequired: false,
      state: { ...state, cursor: frame.cursor },
    };
  }
  if (frame.type === "worktreeRemoved") {
    const byWorktree = { ...state.byWorktree };
    const runtimes = { ...state.runtimes };
    const shellActivities = { ...state.shellActivities };
    delete byWorktree[frame.worktreeId];
    delete runtimes[frame.worktreeId];
    delete shellActivities[frame.worktreeId];
    return {
      resyncRequired: false,
      state: {
        ...state,
        cursor: frame.cursor,
        byWorktree,
        runtimes,
        shellActivities,
        workspaceAttention: frame.workspaceAttention,
      },
    };
  }
  return {
    resyncRequired: false,
    state: {
      ...state,
      cursor: frame.cursor,
      runtimes: {
        ...state.runtimes,
        [frame.runtime.worktreeId]: frame.runtime,
      },
    },
  };
}

export function createWorkflowStatusStore() {
  const { subscribe, set, update } = writable<WorkflowStatusState>(
    initialWorkflowStatusState,
  );
  let current = initialWorkflowStatusState;
  subscribe((state) => (current = state));
  return {
    subscribe,
    current: () => current,
    setChannel(channel: StatusChannelState) {
      update((state) => ({ ...state, channel }));
    },
    apply(frame: ApplicationEventsServerFrame): boolean {
      const reduced = reduceWorkflowStatusState(current, frame);
      if (!reduced.resyncRequired) set(reduced.state);
      return !reduced.resyncRequired;
    },
    removeWorktrees(worktreeIds: string[]) {
      if (worktreeIds.length === 0) return;
      const removed = new Set(worktreeIds);
      update((state) => ({
        ...state,
        byWorktree: Object.fromEntries(
          Object.entries(state.byWorktree).filter(
            ([worktreeId]) => !removed.has(worktreeId),
          ),
        ),
        runtimes: Object.fromEntries(
          Object.entries(state.runtimes).filter(
            ([worktreeId]) => !removed.has(worktreeId),
          ),
        ),
        shellActivities: Object.fromEntries(
          Object.entries(state.shellActivities).filter(
            ([worktreeId]) => !removed.has(worktreeId),
          ),
        ),
      }));
    },
    reset() {
      set(initialWorkflowStatusState);
    },
  };
}

export const workflowStatusStore = createWorkflowStatusStore();
