import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { createGitRepository } from "../fixtures/git-repository.js";

const port = 4321;
let root: string;
let repository: string;
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
  root = mkdtempSync(join(tmpdir(), "pi-dash-terminal-e2e-"));
  repository = createGitRepository(root, "terminal-project");
  const outputFile = join(root, "runtime", "bootstrap-url");
  const fakePi = resolve("tests/fixtures/fake-pi.ts");
  chmodSync(fakePi, 0o755);
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
      "--native-dialog",
      "disabled",
      "--pi-executable",
      fakePi,
      "--log-level",
      "warn",
    ],
    {
      cwd: resolve("."),
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  daemon.stdout?.on(
    "data",
    (chunk: Buffer) => (daemonOutput += chunk.toString()),
  );
  daemon.stderr?.on(
    "data",
    (chunk: Buffer) => (daemonOutput += chunk.toString()),
  );
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

test("starts, interacts with, reconnects to, stops, and restarts a terminal", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  await page.goto(bootstrapUrl);
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add workspace" })
    .click();
  const workspaceDialog = page.getByRole("dialog", { name: "Add workspace" });
  await workspaceDialog.getByLabel("Repository directory").fill(repository);
  await workspaceDialog.getByRole("button", { name: "Continue" }).click();
  await workspaceDialog.getByLabel("Workspace name").fill("Terminal E2E");
  await workspaceDialog.getByRole("button", { name: "Add workspace" }).click();

  await page.getByRole("button", { name: "Create worktree" }).click();
  const createDialog = page.getByRole("dialog", {
    name: "Create managed worktree",
  });
  await createDialog.getByLabel("Name").fill("Terminal work");
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/worktrees") &&
      response.request().method() === "POST",
    { timeout: 15_000 },
  );
  await createDialog.getByRole("button", { name: "Create worktree" }).click();
  const response = await createResponse.catch(() => {
    throw new Error(`Worktree creation did not respond: ${daemonOutput}`);
  });
  const responseBody = await response.text();
  if (!response.ok()) {
    throw new Error(
      `Worktree creation failed (${response.status()}): ${responseBody}\n${daemonOutput}`,
    );
  }
  const createdWorktree = JSON.parse(responseBody).worktree as { id: string };
  await page.waitForTimeout(2_000);
  if (await createDialog.isVisible()) {
    throw new Error(
      `Create dialog remained visible. Page errors: ${pageErrors.join("\n")}`,
    );
  }
  const card = page.locator(".worktree-card", { hasText: "Terminal work" });
  await card.getByRole("button", { name: "Open Pi terminal" }).click();

  const terminal = page.getByRole("application", {
    name: "Terminal E2E Terminal work interactive Pi terminal",
  });
  await expect(terminal).toContainText("FAKE_PI_READY");

  const cookieHeader = (await page.context().cookies())
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const wrongOriginStatus = await new Promise<number>(
    (resolveStatus, reject) => {
      const rejected = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/worktrees/${createdWorktree.id}/terminal/socket`,
        {
          headers: {
            Cookie: cookieHeader,
            Origin: "http://attacker.invalid",
          },
        },
      );
      rejected.once("unexpected-response", (_request, response) => {
        resolveStatus(response.statusCode ?? 0);
        response.destroy();
      });
      rejected.once("open", () =>
        reject(new Error("Wrong-origin socket opened")),
      );
      rejected.once("error", () => undefined);
    },
  );
  expect(wrongOriginStatus).toBe(403);

  const protocolError = await new Promise<string>((resolveCode, reject) => {
    const candidate = new WebSocket(
      `ws://127.0.0.1:${port}/api/v1/worktrees/${createdWorktree.id}/terminal/socket`,
      {
        headers: {
          Cookie: cookieHeader,
          Origin: `http://127.0.0.1:${port}`,
        },
      },
    );
    candidate.once("open", () => {
      candidate.send(JSON.stringify({ v: 0, type: "attach", afterSeq: 0 }));
    });
    candidate.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { code?: string };
      if (frame.code) {
        resolveCode(frame.code);
        candidate.close();
      }
    });
    candidate.once("error", reject);
  });
  expect(protocolError).toBe("TERMINAL_PROTOCOL_MISMATCH");

  await page.getByRole("button", { name: "Focus terminal" }).click();
  await page.keyboard.type("echo-terminal");
  await expect(terminal).toContainText("echo-terminal");

  await page.reload();
  await card.getByRole("button", { name: "Open Pi terminal" }).click();
  await expect(terminal).toContainText("echo-terminal");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText(/Runtime: stopped/)).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText(/Runtime: running/)).toBeVisible();
  await page.getByRole("button", { name: "Focus terminal" }).click();
  await page.keyboard.type("after-restart");
  await expect(terminal).toContainText("after-restart");
});
