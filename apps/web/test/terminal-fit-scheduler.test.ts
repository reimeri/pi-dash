import { describe, expect, it } from "vitest";
import { createTerminalFitScheduler } from "../src/lib/terminal/fit-scheduler.js";

function createFrameQueue(): {
  requestFrame: (callback: () => void) => void;
  runNext: () => void;
  size: () => number;
} {
  const callbacks: Array<() => void> = [];
  return {
    requestFrame: (callback) => callbacks.push(callback),
    runNext: () => callbacks.shift()?.(),
    size: () => callbacks.length,
  };
}

describe("terminal fit scheduler", () => {
  it("does not consume a fit cycle before the terminal is ready", () => {
    const frames = createFrameQueue();
    let ready = false;
    let fits = 0;
    const scheduler = createTerminalFitScheduler({
      canFit: () => ready,
      getDimensions: () => ({ width: 1_000, height: 700 }),
      fit: () => (fits += 1),
      requestFrame: frames.requestFrame,
    });

    scheduler.schedule();
    expect(frames.size()).toBe(0);

    ready = true;
    scheduler.schedule();
    expect(frames.size()).toBe(1);
    for (let index = 0; index < 4; index += 1) frames.runNext();

    expect(fits).toBe(4);
    expect(frames.size()).toBe(0);
  });

  it("restarts settling when a new layout signal arrives mid-cycle", () => {
    const frames = createFrameQueue();
    let fits = 0;
    const scheduler = createTerminalFitScheduler({
      canFit: () => true,
      getDimensions: () => ({ width: 1_000, height: 700 }),
      fit: () => (fits += 1),
      requestFrame: frames.requestFrame,
    });

    scheduler.schedule();
    frames.runNext();
    scheduler.schedule();
    expect(frames.size()).toBe(1);

    for (let index = 0; index < 4; index += 1) frames.runNext();

    expect(fits).toBe(5);
    expect(frames.size()).toBe(0);
  });

  it("stops a queued cycle when hidden or disposed and can restart later", () => {
    const frames = createFrameQueue();
    let active = true;
    let fits = 0;
    const scheduler = createTerminalFitScheduler({
      canFit: () => active,
      getDimensions: () => ({ width: 1_000, height: 700 }),
      fit: () => (fits += 1),
      requestFrame: frames.requestFrame,
    });

    scheduler.schedule();
    active = false;
    frames.runNext();
    expect(fits).toBe(0);
    expect(frames.size()).toBe(0);

    active = true;
    scheduler.schedule();
    for (let index = 0; index < 4; index += 1) frames.runNext();
    expect(fits).toBe(4);
  });

  it("fits through changing dimensions and reports a settled grid", () => {
    const frames = createFrameQueue();
    const widths = [500, 700, 900, 900, 900, 900];
    let frame = 0;
    let fits = 0;
    let settled = 0;
    const scheduler = createTerminalFitScheduler({
      canFit: () => true,
      getDimensions: () => ({
        width: widths[Math.min(frame++, widths.length - 1)],
        height: 700,
      }),
      fit: () => (fits += 1),
      requestFrame: frames.requestFrame,
      onSettled: () => (settled += 1),
    });

    scheduler.schedule();
    while (frames.size() > 0) frames.runNext();

    expect(fits).toBe(6);
    expect(settled).toBe(1);
  });

  it("does not report a settled grid when geometry is unavailable", () => {
    const frames = createFrameQueue();
    let settled = 0;
    const scheduler = createTerminalFitScheduler({
      canFit: () => true,
      getDimensions: () => ({ width: 0, height: 0 }),
      fit: () => undefined,
      requestFrame: frames.requestFrame,
      onSettled: () => (settled += 1),
    });

    scheduler.schedule();
    frames.runNext();

    expect(settled).toBe(0);
  });
});
