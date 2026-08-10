import { describe, expect, it, vi } from "vitest";
import {
  createRetryableModuleLoader,
  preloadTerminalModules,
  scheduleTerminalModulePreload,
  type TerminalPreloadHost,
} from "../src/lib/terminal/module-loaders.js";

describe("terminal module loaders", () => {
  it("shares an in-flight module load and caches its success", async () => {
    let resolve!: (value: { name: string }) => void;
    const importModule = vi.fn(
      () =>
        new Promise<{ name: string }>((done) => {
          resolve = done;
        }),
    );
    const load = createRetryableModuleLoader(importModule);

    const first = load();
    const second = load();
    expect(second).toBe(first);
    expect(importModule).toHaveBeenCalledOnce();

    resolve({ name: "terminal" });
    await expect(first).resolves.toEqual({ name: "terminal" });
    await expect(load()).resolves.toEqual({ name: "terminal" });
    expect(importModule).toHaveBeenCalledOnce();
  });

  it("retries a module load after a speculative failure", async () => {
    const importModule = vi
      .fn<() => Promise<{ name: string }>>()
      .mockRejectedValueOnce(new Error("temporary preload failure"))
      .mockResolvedValue({ name: "terminal" });
    const load = createRetryableModuleLoader(importModule);

    const failures = await Promise.allSettled([load(), load()]);
    expect(failures.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(importModule).toHaveBeenCalledOnce();

    await expect(load()).resolves.toEqual({ name: "terminal" });
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("settles every speculative module load without surfacing failures", async () => {
    const successful = vi.fn().mockResolvedValue({});
    const failed = vi.fn().mockRejectedValue(new Error("unavailable"));

    await expect(
      preloadTerminalModules([successful, failed]),
    ).resolves.toBeUndefined();
    expect(successful).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
  });

  it("uses requestIdleCallback and supports cancellation", async () => {
    let idleCallback: IdleRequestCallback | undefined;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 7;
    });
    const cancelIdleCallback = vi.fn();
    const preload = vi.fn().mockResolvedValue(undefined);
    const host = {
      requestIdleCallback,
      cancelIdleCallback,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    } as unknown as TerminalPreloadHost;

    const cancel = scheduleTerminalModulePreload(preload, host);
    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 2_000,
    });
    expect(host.setTimeout).not.toHaveBeenCalled();

    idleCallback?.({ didTimeout: false, timeRemaining: () => 5 });
    await Promise.resolve();
    expect(preload).toHaveBeenCalledOnce();

    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("falls back to a timer and prevents work after cancellation", () => {
    let timerCallback: (() => void) | undefined;
    const preload = vi.fn().mockResolvedValue(undefined);
    const clearTimeout = vi.fn();
    const host = {
      setTimeout: vi.fn((callback: () => void) => {
        timerCallback = callback;
        return 9;
      }),
      clearTimeout,
    } as unknown as TerminalPreloadHost;

    const cancel = scheduleTerminalModulePreload(preload, host);
    expect(host.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1_000);

    cancel();
    expect(clearTimeout).toHaveBeenCalledWith(9);
    timerCallback?.();
    expect(preload).not.toHaveBeenCalled();
  });
});
