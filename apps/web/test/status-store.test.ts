import type {
  ApplicationEventsServerFrame,
  WorkflowStatusDto,
} from "@pi-dash/contracts";
import { describe, expect, it } from "vitest";
import {
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
    v: 2,
    type: "snapshot",
    cursor: 4,
    statuses: [status],
    runtimes: [],
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
      v: 2,
      type: "status",
      cursor: 5,
      status: { ...status, state: "working", reason: "agent", revision: 1 },
      workspaceAttention: [],
    });
    expect(working.state.byWorktree[status.worktreeId]?.state).toBe("working");
    expect(
      reduceWorkflowStatusState(working.state, {
        v: 2,
        type: "status",
        cursor: 7,
        status: { ...status, state: "done", reason: "settled", revision: 2 },
        workspaceAttention: [],
      }).resyncRequired,
    ).toBe(true);
  });

  it("applies status and workspace aggregate atomically", () => {
    const initialized = reduceWorkflowStatusState(
      initialWorkflowStatusState,
      snapshot(),
    ).state;
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const next = reduceWorkflowStatusState(initialized, {
      v: 2,
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
