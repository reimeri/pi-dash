import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../fixtures/git-repository.js";

const port = 4319;
let root: string;
let repository: string;
let bootstrapUrl: string;
let daemon: ChildProcess;
let daemonOutput = "";

async function waitForServer(outputFile: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(
        `Daemon exited early (${daemon.exitCode}): ${daemonOutput}`,
      );
    }
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
  root = mkdtempSync(join(tmpdir(), "pi-dash-workspaces-e2e-"));
  repository = createGitRepository(root, "e2e-project");
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
      "--native-dialog",
      "disabled",
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

test("typed recovery registers, persists, renames, and removes workspace metadata", async ({
  page,
}) => {
  await page.goto(bootstrapUrl);
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toContainText("Connected");

  await page
    .getByRole("main")
    .getByRole("button", { name: "Add workspace" })
    .click();
  const addDialog = page.getByRole("dialog", { name: "Add workspace" });
  await expect(addDialog.getByLabel("Repository directory")).toBeFocused();
  await addDialog.getByLabel("Repository directory").fill(repository);
  await addDialog.getByRole("button", { name: "Continue" }).click();
  await expect(addDialog.getByText(repository, { exact: true })).toBeVisible();
  await addDialog.getByLabel("Workspace name").fill("E2E Workspace");
  await addDialog.getByRole("button", { name: "Add workspace" }).click();

  await expect(
    page.getByRole("heading", { name: "E2E Workspace" }),
  ).toBeVisible();
  await expect(page.getByText("Repository ready")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Select a workspace" }),
  ).toBeVisible();
  await page.locator(".workspace-select", { hasText: "E2E Workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "E2E Workspace" }),
  ).toBeVisible();

  await page.getByRole("main").getByRole("button", { name: "Rename" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename workspace" });
  await renameDialog.getByLabel("Workspace name").fill("Renamed Workspace");
  await renameDialog.getByRole("button", { name: "Save name" }).click();
  await expect(
    page.getByRole("heading", { name: "Renamed Workspace" }),
  ).toBeVisible();

  await page.getByRole("main").getByRole("button", { name: "Remove" }).click();
  const removeDialog = page.getByRole("dialog", { name: "Remove workspace" });
  await removeDialog.getByRole("button", { name: "Remove workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Add a workspace to get started" }),
  ).toBeVisible();
  expect(existsSync(repository)).toBe(true);

  await page
    .getByRole("main")
    .getByRole("button", { name: "Add workspace" })
    .click();
  await page
    .getByRole("dialog", { name: "Add workspace" })
    .getByRole("button", { name: "Cancel" })
    .click();
  await expect(page.getByRole("dialog", { name: "Add workspace" })).toHaveCount(
    0,
  );
});
