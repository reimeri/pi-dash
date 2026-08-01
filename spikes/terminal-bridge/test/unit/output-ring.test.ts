import { describe, expect, it } from "vitest";
import { OutputRing } from "../../src/output-ring.js";

describe("OutputRing", () => {
  it("assigns monotonic sequences and replays from a boundary", () => {
    const ring = new OutputRing(100);
    ring.push("one");
    ring.push("two");
    expect(ring.earliestSeq).toBe(1);
    expect(ring.latestSeq).toBe(2);
    expect(ring.replayFrom(2).map((entry) => entry.data)).toEqual(["two"]);
    expect(ring.canReplayFrom(3)).toBe(true);
  });

  it("evicts complete oldest entries when the byte cap wraps", () => {
    const ring = new OutputRing(6);
    ring.push("111");
    ring.push("222");
    ring.push("333");
    expect(ring.bytes).toBeLessThanOrEqual(6);
    expect(ring.earliestSeq).toBe(2);
    expect(ring.canReplayFrom(1)).toBe(false);
    expect(ring.replayFrom(2).map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it("does not retain an individual frame larger than the cap", () => {
    const ring = new OutputRing(2);
    ring.push("oversized");
    expect(ring.bytes).toBe(0);
    expect(ring.length).toBe(0);
    expect(ring.earliestSeq).toBe(2);
  });
});
