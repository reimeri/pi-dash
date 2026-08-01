import type {
  ApplicationEventsServerFrame,
  RuntimeDto,
  WorkflowStatusDto,
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
      workspaceAttention: () => [],
    });
    events.subscribe({
      bufferedAmount: 0,
      send: (frame) => received.push(frame),
      close: () => undefined,
    });
    events.publishStatus({ ...status, state: "working", revision: 1 });
    events.publishRuntime({ ...runtime, state: "starting" });
    expect(received.map((frame) => frame.type)).toEqual([
      "snapshot",
      "status",
      "runtime",
    ]);
    expect(received.map((frame) => "cursor" in frame && frame.cursor)).toEqual([
      0, 1, 2,
    ]);
  });

  it("disconnects a subscriber that exceeds bounded buffering", () => {
    const closes: number[] = [];
    const events = createApplicationEvents({
      statuses: () => [status],
      runtimes: () => [runtime],
      workspaceAttention: () => [],
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
