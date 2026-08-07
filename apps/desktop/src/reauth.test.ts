import { describe, expect, it, vi } from "vitest";
import {
  daemonHealthReady,
  requestDesktopRebootstrap,
  validateBootstrapUrl,
  waitForDaemonHealth,
} from "../src/reauth.js";

const launchUrl =
  "http://127.0.0.1:4317/auth/bootstrap?token=abcdefghijklmnopqrstuvwxyz012345";

function stalledFetch(): typeof fetch {
  return ((_input: URL | RequestInfo, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    })) as typeof fetch;
}

describe("desktop reauth helpers", () => {
  it("accepts loopback bootstrap URLs", () => {
    const launch = validateBootstrapUrl(launchUrl);
    expect(launch.origin).toBe("http://127.0.0.1:4317");
  });

  it("rejects non-bootstrap URLs", () => {
    expect(() =>
      validateBootstrapUrl(
        "http://127.0.0.1:4317/?token=abcdefghijklmnopqrstuvwxyz012345",
      ),
    ).toThrow(/invalid desktop launch URL/);
  });

  it("requests a fresh bootstrap URL with the control token", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ bootstrapUrl: launchUrl }),
    ) as unknown as typeof fetch;
    await expect(
      requestDesktopRebootstrap({
        origin: "http://127.0.0.1:4317",
        controlToken: "control-token",
        fetchImpl,
      }),
    ).resolves.toContain("/auth/bootstrap?token=");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4317/auth/desktop/rebootstrap",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer control-token",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("times out stalled desktop rebootstrap requests", async () => {
    await expect(
      requestDesktopRebootstrap({
        origin: "http://127.0.0.1:4317",
        controlToken: "control-token",
        fetchImpl: stalledFetch(),
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("reports daemon health readiness and bounds stalled checks", async () => {
    const ok = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(
      daemonHealthReady({
        origin: "http://127.0.0.1:4317",
        fetchImpl: ok as unknown as typeof fetch,
      }),
    ).resolves.toBe(true);
    await expect(
      daemonHealthReady({
        origin: "http://127.0.0.1:4317",
        fetchImpl: stalledFetch(),
        timeoutMs: 5,
      }),
    ).resolves.toBe(false);
  });

  it("retries daemon health until it recovers", async () => {
    let now = 0;
    const responses = [503, 503, 200];
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: responses.shift() ?? 503 }),
    ) as unknown as typeof fetch;
    const onRetrying = vi.fn();

    await expect(
      waitForDaemonHealth({
        origin: "http://127.0.0.1:4317",
        fetchImpl,
        retryWindowMs: 15_000,
        retryIntervalMs: 1_000,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
        onRetrying,
      }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onRetrying).toHaveBeenCalledTimes(1);
    expect(now).toBe(2_000);
  });

  it("stops retrying daemon health at the configured deadline", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));

    await expect(
      waitForDaemonHealth({
        origin: "http://127.0.0.1:4317",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryWindowMs: 2_500,
        retryIntervalMs: 1_000,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      }),
    ).resolves.toBe(false);
    expect(now).toBe(2_500);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});
