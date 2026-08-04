import type {
  ApplicationEventsServerFrame,
  RuntimeDto,
  WorkflowStatusDto,
  WorkspaceDto,
} from "@pi-dash/contracts";
import { describe, expect, it } from "vitest";
import { createApplicationEvents } from "../src/events/application-events.js";

const status: WorkflowStatusDto = {
  worktreeId: "11111111-1111-4111-8111-111111111111",
  state: "idle",
  reason: null,
  revision: 0,
  changedAt: "2026-01-01T00:00:00.000Z",
  acknowledgedAt: null,
  integration: "disconnected",
};
const workspace: WorkspaceDto = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Example",
  slug: "example",
  repositoryPath: "/tmp/example",
  repository: {
    health: "healthy",
    syncStatus: "synchronized",
    currentBranch: "main",
    headCommit: "a".repeat(40),
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
  worktreeCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const runtime: RuntimeDto = {
  worktreeId: status.worktreeId,
  runtimeId: null,
  state: "stopped",
  startedAt: null,
  exitedAt: null,
  exitCode: null,
  signal: null,
  attachedClients: 0,
};

describe("application event stream", () => {
  it("sends one atomic cursor snapshot before ordered incrementals", () => {
    const received: ApplicationEventsServerFrame[] = [];
    const events = createApplicationEvents({
      statuses: () => [status],
      runtimes: () => [runtime],
      shellActivities: () => [],
      workspaceAttention: () => [],
      environmentChanges: () => [],
    });
    events.subscribe({
      bufferedAmount: 0,
      send: (frame) => received.push(frame),
      close: () => undefined,
    });
    events.publishStatus({ ...status, state: "working", revision: 1 });
    events.publishRuntime({ ...runtime, state: "starting" });
    events.publishShellActivity({
      worktreeId: status.worktreeId,
      runtimeId: "33333333-3333-4333-8333-333333333333",
      foregroundCommandActive: true,
      changedAt: "2026-01-01T00:00:01.000Z",
    });
    events.publishWorkspaceUpdated(workspace);
    events.publishWorkspaceOrderUpdated([workspace.id]);
    events.publishWorkspaceEnvironmentChanged(workspace.id);
    events.publishWorktreeRemoved(
      status.worktreeId,
      "22222222-2222-4222-8222-222222222222",
    );
    expect(received.map((frame) => frame.type)).toEqual([
      "snapshot",
      "status",
      "runtime",
      "shellActivity",
      "workspaceUpdated",
      "workspaceOrderUpdated",
      "workspaceEnvironmentChanged",
      "worktreeRemoved",
    ]);
    expect(received.map((frame) => frame.v)).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
    expect(received.map((frame) => "cursor" in frame && frame.cursor)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(received[5]).toMatchObject({
      type: "workspaceOrderUpdated",
      workspaceIds: [workspace.id],
    });
  });

  it("disconnects a subscriber that exceeds bounded buffering", () => {
    const closes: number[] = [];
    const events = createApplicationEvents({
      statuses: () => [status],
      runtimes: () => [runtime],
      shellActivities: () => [],
      workspaceAttention: () => [],
      environmentChanges: () => [],
      maxBufferedBytes: 1,
    });
    events.subscribe({
      bufferedAmount: 1,
      send: () => undefined,
      close: (code) => closes.push(code),
    });
    expect(closes).toEqual([1013]);
  });
});
