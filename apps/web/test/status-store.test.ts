import type {
  ApplicationEventsServerFrame,
  WorkflowStatusDto,
} from "@pi-dash/contracts";
import { describe, expect, it } from "vitest";
import {
  createWorkflowStatusStore,
  initialWorkflowStatusState,
  reduceWorkflowStatusState,
} from "../src/lib/status/store.js";

const status: WorkflowStatusDto = {
  worktreeId: "11111111-1111-4111-8111-111111111111",
  state: "idle",
  reason: null,
  revision: 0,
  changedAt: "2026-01-01T00:00:00.000Z",
  acknowledgedAt: null,
  integration: "connected",
};

function snapshot(): ApplicationEventsServerFrame {
  return {
    v: 6,
    type: "snapshot",
    cursor: 4,
    statuses: [status],
    runtimes: [
      {
        worktreeId: status.worktreeId,
        runtimeId: null,
        state: "stopped",
        startedAt: null,
        exitedAt: null,
        exitCode: null,
        signal: null,
        attachedClients: 0,
      },
    ],
    shellActivities: [],
    workspaceAttention: [],
  };
}

describe("workflow status store", () => {
  it("atomically replaces state from a cursor snapshot", () => {
    const result = reduceWorkflowStatusState(
      initialWorkflowStatusState,
      snapshot(),
    );
    expect(result.resyncRequired).toBe(false);
    expect(result.state).toMatchObject({
      cursor: 4,
      snapshotReceived: true,
      channel: "connected",
    });
    expect(result.state.byWorktree[status.worktreeId]).toEqual(status);
  });

  it("applies ordered incrementals and requires resync for a cursor gap", () => {
    const initialized = reduceWorkflowStatusState(
      initialWorkflowStatusState,
      snapshot(),
    ).state;
    const working = reduceWorkflowStatusState(initialized, {
      v: 6,
      type: "status",
      cursor: 5,
      status: { ...status, state: "working", reason: "agent", revision: 1 },
      workspaceAttention: [],
    });
    expect(working.state.byWorktree[status.worktreeId]?.state).toBe("working");
    expect(
      reduceWorkflowStatusState(working.state, {
        v: 6,
        type: "status",
        cursor: 7,
        status: { ...status, state: "done", reason: "settled", revision: 2 },
        workspaceAttention: [],
      }).resyncRequired,
    ).toBe(true);
  });

  it("tracks shell foreground activity from ordered events", () => {
    const initialized = reduceWorkflowStatusState(
      initialWorkflowStatusState,
      snapshot(),
    ).state;
    const activity = {
      worktreeId: status.worktreeId,
      runtimeId: "33333333-3333-4333-8333-333333333333",
      foregroundCommandActive: true,
      changedAt: "2026-01-01T00:00:01.000Z",
    } as const;
    const active = reduceWorkflowStatusState(initialized, {
      v: 6,
      type: "shellActivity",
      cursor: 5,
      activity,
    });
    expect(active.state.shellActivities[status.worktreeId]).toEqual(activity);
  });

  it("evicts deleted worktree status and runtime state", () => {
    const initialized = reduceWorkflowStatusState(
      initialWorkflowStatusState,
      snapshot(),
    ).state;
    const removed = reduceWorkflowStatusState(initialized, {
      v: 6,
      type: "worktreeRemoved",
      cursor: 5,
      worktreeId: status.worktreeId,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      workspaceAttention: [],
    });
    expect(removed.state.byWorktree[status.worktreeId]).toBeUndefined();
    expect(removed.state.runtimes[status.worktreeId]).toBeUndefined();
  });

  it("explicitly clears worktrees removed with workspace metadata", () => {
    const store = createWorkflowStatusStore();
    expect(store.apply(snapshot())).toBe(true);
    store.removeWorktrees([status.worktreeId]);
    expect(store.current().byWorktree[status.worktreeId]).toBeUndefined();
    expect(store.current().runtimes[status.worktreeId]).toBeUndefined();
  });

  it("applies status and workspace aggregate atomically", () => {
    const initialized = reduceWorkflowStatusState(
      initialWorkflowStatusState,
      snapshot(),
    ).state;
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const next = reduceWorkflowStatusState(initialized, {
      v: 6,
      type: "status",
      cursor: 5,
      status: {
        ...status,
        state: "done",
        reason: "settled",
        revision: 1,
      },
      workspaceAttention: [
        {
          workspaceId,
          state: "done",
          count: 1,
          integration: "connected",
        },
      ],
    });
    expect(next.state.byWorktree[status.worktreeId]?.state).toBe("done");
    expect(next.state.workspaceAttention).toEqual([
      {
        workspaceId,
        state: "done",
        count: 1,
        integration: "connected",
      },
    ]);
  });
});
