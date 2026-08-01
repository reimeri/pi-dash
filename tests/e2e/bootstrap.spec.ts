import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { test, expect } from "@playwright/test";

const port = 4318;
let root: string;
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

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-dash-e2e-"));
  const outputFile = join(root, "runtime", "bootstrap-url");
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
      outputFile,
      "--log-level",
      "warn",
    ],
    {
      cwd: resolve("."),
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  daemon.stdout?.on("data", (chunk: Buffer) => {
    daemonOutput += chunk.toString();
  });
  daemon.stderr?.on("data", (chunk: Buffer) => {
    daemonOutput += chunk.toString();
  });
  await waitForServer(outputFile);
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
  ).toContainText("Connected");
  expect(page.url()).not.toContain("token");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);

  await page.goBack();
  expect(page.url()).not.toContain("token=");
  await page.goto(`http://127.0.0.1:${port}/`);
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toContainText("Connected");
  await page.reload();
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toContainText("Connected");

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
    page.getByRole("heading", { name: "Open Pi Dash from its launch link" }),
  ).toBeVisible();
});
