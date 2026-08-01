import { expect, test, type APIRequestContext } from "@playwright/test";

interface BrowserHeartbeat {
  last: number;
  maxIntervalMs: number;
  ticks: number;
  timer: number;
}

interface Diagnostics {
  runtime: { pid: number; state: string; exitCode: number | null };
  terminal: { cols: number; rows: number; latestSeq: number; bufferedBytes: number; totalOutputBytes: number };
  status: { state: string };
  resources: { websocketConnections: number };
}

async function serverDiagnostics(request: APIRequestContext): Promise<Diagnostics> {
  const response = await request.get("/spike/diagnostics");
  expect(response.ok()).toBe(true);
  return response.json();
}

test("xterm bridge resizes, reconnects, streams, reports status, and disposes resources", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.getByTestId("socket-state")).toHaveText("connected", { timeout: 5_000 });
  await expect(page.getByRole("application", { name: "Interactive Pi terminal" })).toBeVisible();
  const initial = await serverDiagnostics(request);
  const pid = initial.runtime.pid;

  const terminal = page.getByTestId("terminal-region");
  await terminal.click();
  await page.keyboard.type("unicode-λ-界");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await serverDiagnostics(request)).terminal.latestSeq).toBeGreaterThan(initial.terminal.latestSeq);

  await terminal.click();
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Alt+Enter");
  await expect.poll(() => page.evaluate(() => ({
    shift: window.__terminalSpikeDiagnostics?.translatedShiftEnter,
    alt: window.__terminalSpikeDiagnostics?.translatedAltEnter,
  }))).toEqual({ shift: 1, alt: 1 });

  const beforePaste = (await serverDiagnostics(request)).terminal.latestSeq;
  await page.getByRole("textbox", { name: "Terminal input" }).evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "paste line one\npaste line two λ界");
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect.poll(async () => (await serverDiagnostics(request)).terminal.latestSeq).toBeGreaterThan(beforePaste);

  const oldCols = (await serverDiagnostics(request)).terminal.cols;
  await page.setViewportSize({ width: 900, height: 720 });
  await expect.poll(async () => (await serverDiagnostics(request)).terminal.cols).not.toBe(oldCols);

  await terminal.click();
  await page.keyboard.type("status");
  await page.keyboard.press("Enter");
  await expect(page.getByText("blocked", { exact: true })).toBeVisible();
  await expect(page.getByText("done", { exact: true })).toBeVisible();

  const beforeRefresh = performance.now();
  await page.reload();
  await expect(page.getByTestId("socket-state")).toHaveText("connected", { timeout: 2_000 });
  await expect(page.getByText(/STATUS_SEQUENCE_SENT/)).toBeVisible({ timeout: 2_000 });
  const beforeReconnectProof = (await serverDiagnostics(request)).terminal.latestSeq;
  await page.getByTestId("terminal-region").click();
  await page.keyboard.type("reconnect-proof");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await serverDiagnostics(request)).terminal.latestSeq).toBeGreaterThan(beforeReconnectProof);
  const reconnectMs = performance.now() - beforeRefresh;
  expect(reconnectMs).toBeLessThan(2_000);
  expect((await serverDiagnostics(request)).runtime.pid).toBe(pid);

  const toggle = page.getByTestId("toggle-terminal");
  for (let warmup = 0; warmup < 5; warmup++) {
    await toggle.click();
    await expect(page.getByTestId("terminal-unmounted")).toBeVisible();
    await toggle.click();
    await expect(page.getByTestId("terminal-region")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__terminalSpikeDiagnostics?.activeAddons)).toBe(2);
  }
  await page.evaluate(() => (globalThis as typeof globalThis & { gc?: () => void }).gc?.());
  const heapBefore = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

  for (let cycle = 0; cycle < 100; cycle++) {
    await toggle.click();
    await expect(page.getByTestId("terminal-unmounted")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__terminalSpikeDiagnostics?.activeTerminals)).toBe(0);
    await toggle.click();
    await expect(page.getByTestId("terminal-region")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__terminalSpikeDiagnostics?.activeAddons)).toBe(2);
  }

  await toggle.click();
  await expect.poll(() => page.evaluate(() => ({
    terminals: window.__terminalSpikeDiagnostics?.activeTerminals,
    sockets: window.__terminalSpikeDiagnostics?.activeSockets,
    observers: window.__terminalSpikeDiagnostics?.activeObservers,
    addons: window.__terminalSpikeDiagnostics?.activeAddons,
  }))).toEqual({ terminals: 0, sockets: 0, observers: 0, addons: 0 });
  await expect.poll(async () => (await serverDiagnostics(request)).resources.websocketConnections).toBe(0);
  await expect(page.locator(".xterm")).toHaveCount(0);
  const translationsBeforeUnmountedKey = await page.evaluate(
    () => window.__terminalSpikeDiagnostics?.translatedShiftEnter,
  );
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  });
  expect(await page.evaluate(() => window.__terminalSpikeDiagnostics?.translatedShiftEnter)).toBe(
    translationsBeforeUnmountedKey,
  );
  await page.evaluate(() => (globalThis as typeof globalThis & { gc?: () => void }).gc?.());
  const heapAfter = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  const retainedHeapRatio = heapBefore > 0 ? heapAfter / heapBefore : 0;
  if (heapBefore > 0) expect(retainedHeapRatio).toBeLessThan(1.1);

  await toggle.click();
  await expect(page.getByTestId("socket-state")).toHaveText("connected");
  const sustainedStart = (await serverDiagnostics(request)).terminal;
  await page.evaluate(() => {
    const target = window as typeof window & { __spikeHeartbeat?: BrowserHeartbeat };
    const heartbeat: BrowserHeartbeat = {
      last: performance.now(),
      maxIntervalMs: 0,
      ticks: 0,
      timer: 0,
    };
    heartbeat.timer = window.setInterval(() => {
      const now = performance.now();
      heartbeat.maxIntervalMs = Math.max(heartbeat.maxIntervalMs, now - heartbeat.last);
      heartbeat.last = now;
      heartbeat.ticks++;
    }, 100);
    target.__spikeHeartbeat = heartbeat;
  });
  const sustainedStarted = performance.now();
  let maxControlLatencyMs = 0;
  await page.getByTestId("terminal-region").click();
  await page.keyboard.type("sustain");
  await page.keyboard.press("Enter");
  for (let second = 1; second <= 30; second++) {
    const delay = sustainedStarted + second * 1_000 - performance.now();
    if (delay > 0) await page.waitForTimeout(delay);
    const controlStarted = performance.now();
    await page.getByRole("button", { name: "Focus terminal" }).click();
    const controlLatencyMs = performance.now() - controlStarted;
    maxControlLatencyMs = Math.max(maxControlLatencyMs, controlLatencyMs);
    expect(controlLatencyMs).toBeLessThan(1_000);
  }
  await expect
    .poll(
      async () => (await serverDiagnostics(request)).terminal.totalOutputBytes - sustainedStart.totalOutputBytes,
      { timeout: 1_000 },
    )
    .toBeGreaterThanOrEqual(150 * 1024 * 1024);
  const deliveredOutputMs = performance.now() - sustainedStarted;
  expect(deliveredOutputMs).toBeLessThanOrEqual(30_500);
  await expect(page.getByText(/SUSTAIN_DONE/)).toBeVisible({ timeout: 5_000 });
  const sustainedOutputMs = performance.now() - sustainedStarted;
  const browserHeartbeat = await page.evaluate(() => {
    const target = window as typeof window & { __spikeHeartbeat?: BrowserHeartbeat };
    const heartbeat = target.__spikeHeartbeat;
    if (!heartbeat) return { maxIntervalMs: Number.POSITIVE_INFINITY, ticks: 0 };
    clearInterval(heartbeat.timer);
    return { maxIntervalMs: heartbeat.maxIntervalMs, ticks: heartbeat.ticks };
  });
  const sustainedEnd = (await serverDiagnostics(request)).terminal;
  expect(browserHeartbeat.ticks).toBeGreaterThanOrEqual(250);
  expect(browserHeartbeat.maxIntervalMs).toBeLessThan(1_000);
  expect(sustainedOutputMs).toBeGreaterThanOrEqual(29_000);
  expect(sustainedOutputMs).toBeLessThan(32_000);
  expect(sustainedEnd.latestSeq - sustainedStart.latestSeq).toBeGreaterThan(1_000);
  console.info(
    "SPIKE_METRICS",
    JSON.stringify({
      reconnectMs,
      deliveredOutputMs,
      sustainedOutputMs,
      browserHeartbeatMs: browserHeartbeat.maxIntervalMs,
      maxControlLatencyMs,
      heapBefore,
      heapAfter,
      retainedHeapRatio,
    }),
  );

  await page.getByTestId("terminal-region").click();
  await page.keyboard.type("exit:7");
  await page.keyboard.press("Enter");
  await expect(page.getByText("exited (7)", { exact: true })).toBeVisible();
});
