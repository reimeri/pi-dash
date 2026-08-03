import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createGitRepository } from "../fixtures/git-repository.js";

const port = 4323;
let root: string;
let repositories: string[];
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

async function addWorkspace(
  page: Page,
  repository: string,
  name: string,
): Promise<void> {
  await page.getByRole("button", { name: "Add workspace" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByLabel("Repository directory").fill(repository);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await dialog.getByLabel("Workspace name").fill(name);
  await dialog.getByRole("button", { name: "Add workspace" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function dragWorkspace(
  page: Page,
  sourceName: string,
  targetName: string,
  holdMs: number,
): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Workspaces" });
  const source = navigation.getByRole("button", {
    name: sourceName,
    exact: true,
  });
  const target = navigation.getByRole("button", {
    name: targetName,
    exact: true,
  });
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Workspace row is not visible");

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
}

function workspaceNames(page: Page) {
  return page
    .getByRole("navigation", { name: "Workspaces" })
    .locator("[data-workspace-drag-surface]");
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-dash-workspace-order-e2e-"));
  repositories = [
    createGitRepository(root, "first-order"),
    createGitRepository(root, "second-order"),
    createGitRepository(root, "third-order"),
  ];
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

test("long-press dragging rearranges and persists workspace order", async ({
  page,
}) => {
  await page.goto(bootstrapUrl);
  await expect(
    page.getByRole("status", { name: "Daemon connection" }),
  ).toHaveAttribute("title", "Connected");

  await addWorkspace(page, repositories[0]!, "First workspace");
  await addWorkspace(page, repositories[1]!, "Second workspace");
  await addWorkspace(page, repositories[2]!, "Third workspace");
  await expect(workspaceNames(page)).toHaveText([
    "Third workspace",
    "Second workspace",
    "First workspace",
  ]);

  const firstWorkspace = page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "First workspace", exact: true });
  await firstWorkspace.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "First workspace" }),
  ).toBeVisible();

  await dragWorkspace(page, "Third workspace", "First workspace", 200);
  await expect(workspaceNames(page)).toHaveText([
    "Third workspace",
    "Second workspace",
    "First workspace",
  ]);

  await dragWorkspace(page, "Expand Third workspace", "First workspace", 550);
  await expect(workspaceNames(page)).toHaveText([
    "Third workspace",
    "Second workspace",
    "First workspace",
  ]);

  await dragWorkspace(page, "Third workspace", "First workspace", 550);
  await expect(workspaceNames(page)).toHaveText([
    "Second workspace",
    "First workspace",
    "Third workspace",
  ]);

  await page.reload();
  await expect(workspaceNames(page)).toHaveText([
    "Second workspace",
    "First workspace",
    "Third workspace",
  ]);
});
