import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect } from "@playwright/test";

const port = 4318;
let root: string;
let bootstrapOutputFile: string;
let bootstrapUrl: string;
let daemon: ChildProcess;
let daemonOutput = "";

async function waitForServer(outputFile: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null)
      throw new Error(
        `Daemon exited early (${daemon.exitCode}): ${daemonOutput}`,
      );
    try {
      bootstrapUrl = (await readFile(outputFile, "utf8")).trim();
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { Host: `127.0.0.1:${port}` },
      });
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for daemon: ${daemonOutput}`);
}

async function waitForBootstrapChange(previous: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const next = (await readFile(bootstrapOutputFile, "utf8")).trim();
    if (next && next !== previous) return next;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for a refreshed launch link");
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-dash-e2e-"));
  bootstrapOutputFile = join(root, "runtime", "bootstrap-url");
  daemon = spawn(
    process.execPath,
    [
      resolve("apps/server/dist/cli.js"),
      "--port",
      String(port),
      "--data-dir",
      join(root, "data"),
      "--config-dir",
      join(root, "config"),
      "--runtime-dir",
      join(root, "runtime"),
      "--bootstrap-output",
      bootstrapOutputFile,
      "--log-level",
      "warn",
    ],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        PI_DASH_NO_OPEN: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  daemon.stdout?.on("data", (chunk: Buffer) => {
    daemonOutput += chunk.toString();
  });
  daemon.stderr?.on("data", (chunk: Buffer) => {
    daemonOutput += chunk.toString();
  });
  await waitForServer(bootstrapOutputFile);
});

test.afterAll(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        daemon.kill("SIGKILL");
        resolveExit();
      }, 5_000);
      daemon.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test("bootstrap lands on a clean authenticated dashboard and survives reload", async ({
  page,
}) => {
  await page.goto(bootstrapUrl);
  await expect(page).toHaveURL(`http://127.0.0.1:${port}/`);
  await expect(
    page.getByRole("heading", { name: "Add a workspace to get started" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toHaveAttribute("title", "Connected");
  const dashboardBox = await page.getByTestId("dashboard-shell").boundingBox();
  expect(dashboardBox).not.toBeNull();
  expect(
    Math.abs(
      dashboardBox!.y + dashboardBox!.height - page.viewportSize()!.height,
    ),
  ).toBeLessThanOrEqual(1);
  expect(page.url()).not.toContain("token");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);

  await page.goBack();
  expect(page.url()).not.toContain("token=");
  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toHaveAttribute("title", "Connected");
  await page.reload();
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toHaveAttribute("title", "Connected");

  const healthUrl = `http://127.0.0.1:${port}/api/v1/health`;
  await page.route(healthUrl, (route) => route.abort("connectionrefused"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("Daemon disconnected")).toBeVisible();
  await page.unroute(healthUrl);
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toHaveAttribute("title", "Connected", { timeout: 15_000 });

  await page.goto(bootstrapUrl);
  await expect(page).toHaveURL(`http://127.0.0.1:${port}/auth/bootstrap`);
  expect(page.url()).not.toContain("token=");
  await page.goBack();
  expect(page.url()).not.toContain("token=");
});

test("unauthenticated and wrong-origin API requests are denied", async ({
  page,
  request,
}) => {
  const unauthorized = await request.get(
    `http://127.0.0.1:${port}/api/v1/session`,
  );
  expect(unauthorized.status()).toBe(401);
  expect((await unauthorized.json()).error.code).toBe("UNAUTHORIZED");

  const forbidden = await request.get(
    `http://127.0.0.1:${port}/api/v1/health`,
    {
      headers: { Origin: "http://attacker.invalid" },
    },
  );
  expect(forbidden.status()).toBe(403);
  expect((await forbidden.json()).error.code).toBe("FORBIDDEN_ORIGIN");

  const wrongHost = await request.get(
    `http://127.0.0.1:${port}/api/v1/health`,
    { headers: { Host: "attacker.invalid" } },
  );
  expect(wrongHost.status()).toBe(403);

  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(
    page.getByRole("heading", { name: "Authenticate with Pi Dash" }),
  ).toBeVisible();
  await expect(
    page.getByText("Open a fresh local launch link", { exact: false }),
  ).toBeVisible();
});

test("SIGUSR1 issues a fresh launch link for a new browser session", async ({
  browser,
}) => {
  const previous = (await readFile(bootstrapOutputFile, "utf8")).trim();
  daemon.kill("SIGUSR1");
  const refreshed = await waitForBootstrapChange(previous);
  expect(refreshed).not.toBe(previous);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(refreshed);
  await expect(page).toHaveURL(`http://127.0.0.1:${port}/`);
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toHaveAttribute("title", "Connected");
  await context.close();
});
