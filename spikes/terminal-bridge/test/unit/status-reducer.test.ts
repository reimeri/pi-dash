import { describe, expect, it } from "vitest";
import type { StatusEventFrame } from "../../src/protocol.js";
import { initialStatus, reduceStatus } from "../../src/status-reducer.js";

const base = { v: 0, runtimeId: "runtime", token: "token" } as const;
const event = (event: StatusEventFrame["event"], interactionId?: string): StatusEventFrame => ({
  ...base,
  event,
  interactionId,
});

describe("status reducer", () => {
  it("tracks working, correlated blocking waits, and settled", () => {
    let status = reduceStatus(initialStatus(), event("agent_start"));
    expect(status.state).toBe("working");
    status = reduceStatus(status, event("blocking_wait_start", "a"));
    status = reduceStatus(status, event("blocking_wait_start", "b"));
    expect(status.state).toBe("blocked");
    status = reduceStatus(status, event("blocking_wait_end", "a"));
    expect(status.state).toBe("blocked");
    status = reduceStatus(status, event("blocking_wait_end", "b"));
    expect(status.state).toBe("working");
    status = reduceStatus(status, event("agent_settled"));
    expect(status.state).toBe("done");
    expect(status.blockingInteractions.size).toBe(0);
  });

  it("ignores malformed or stale blocking events instead of creating a false transition", () => {
    const initial = initialStatus();
    expect(reduceStatus(initial, event("blocking_wait_start")).state).toBe("idle");
    const done = reduceStatus(initial, event("agent_settled"));
    expect(reduceStatus(done, event("blocking_wait_end", "unknown"))).toBe(done);
  });

  it("allows a correlated blocking wait after an earlier settled run", () => {
    const done = reduceStatus(initialStatus(), event("agent_settled"));
    const blocked = reduceStatus(done, event("blocking_wait_start", "later"));
    expect(blocked.state).toBe("blocked");
  });
});
