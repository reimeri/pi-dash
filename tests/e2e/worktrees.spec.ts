import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createGitRepository } from "../fixtures/git-repository.js";

const port = 4320;
let root: string;
let repository: string;
let bootstrapUrl: string;
let daemon: ChildProcess;
let daemonOutput = "";
let outputFile: string;

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

async function restartDaemon(): Promise<void> {
  daemon.kill("SIGTERM");
  await new Promise<void>((resolveExit) =>
    daemon.once("exit", () => resolveExit()),
  );
  daemonOutput = "";
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
  daemon.stdout?.on(
    "data",
    (chunk: Buffer) => (daemonOutput += chunk.toString()),
  );
  daemon.stderr?.on(
    "data",
    (chunk: Buffer) => (daemonOutput += chunk.toString()),
  );
  await waitForServer(outputFile);
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-dash-worktrees-e2e-"));
  repository = createGitRepository(root, "e2e-project");
  outputFile = join(root, "runtime", "bootstrap-url");
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

test("creates, persists, protects dirty state, removes, and safely deletes a branch", async ({
  page,
}) => {
  await page.goto(bootstrapUrl);
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add workspace" })
    .click();
  const workspaceDialog = page.getByRole("dialog", { name: "Add workspace" });
  await workspaceDialog.getByLabel("Repository directory").fill(repository);
  await workspaceDialog.getByRole("button", { name: "Continue" }).click();
  await workspaceDialog.getByLabel("Workspace name").fill("Worktree E2E");
  await workspaceDialog.getByRole("button", { name: "Add workspace" }).click();
  await expect(
    page.getByRole("button", { name: "New worktree in Worktree E2E" }),
  ).toBeVisible();

  await page.reload();
  const selectWorkspaceHeading = page.getByRole("heading", {
    name: "Select a workspace",
  });
  await expect(selectWorkspaceHeading).toBeVisible();
  await page
    .getByRole("button", { name: "New worktree in Worktree E2E" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Select a workspace" }),
  ).toBeVisible();
  const createDialog = page.getByRole("dialog", {
    name: "Create managed worktree",
  });
  await expect(createDialog.getByLabel("Base")).toBeEnabled();
  await createDialog.getByLabel("Name").fill("Feature work");
  await expect(createDialog.getByLabel("Slug")).toHaveValue("feature-work");
  await createDialog.getByRole("button", { name: "Create worktree" }).click();
  await page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "Worktree E2E", exact: true })
    .click();

  const card = page.getByRole("article", { name: "Feature work" });
  await expect(card).toContainText("ready");
  const managedPath = (await card
    .getByTestId("worktree-path")
    .textContent())!.trim();
  await restartDaemon();
  await page.goto(bootstrapUrl);
  await expect(
    page.getByRole("heading", { name: "Select a workspace" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "Worktree E2E", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Feature work" }),
  ).toBeVisible();

  const dirt = join(managedPath, "untracked-e2e.txt");
  writeFileSync(dirt, "protect me\nstill dirty\n");
  const workspaceNavigation = page.getByRole("navigation", {
    name: "Workspaces",
  });
  const featureWorkButton = workspaceNavigation.getByRole("button", {
    name: "Feature work",
    exact: true,
  });
  if (!(await featureWorkButton.isVisible())) {
    await workspaceNavigation
      .getByRole("button", { name: "Expand Worktree E2E" })
      .click();
  }
  await featureWorkButton.click();
  const diffButton = page.getByRole("button", { name: /View changes/ });
  await expect(diffButton).toHaveAccessibleName(
    /2 added lines, 0 deleted lines/,
  );
  await diffButton.click();
  await expect(page.getByRole("heading", { name: "Changes" })).toBeVisible();
  await expect(
    page.getByText("untracked-e2e.txt", { exact: false }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Close changes" }).click();
  await page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "Worktree E2E", exact: true })
    .click();
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  let removeDialog = page.getByRole("alertdialog", {
    name: "Remove managed worktree",
  });
  await removeDialog
    .getByRole("button", { name: "Remove clean worktree" })
    .click();
  await expect(removeDialog).toContainText("tracked or untracked changes");
  unlinkSync(dirt);
  await removeDialog.getByRole("button", { name: "Cancel" }).click();

  await card.getByRole("button", { name: "Remove", exact: true }).click();
  removeDialog = page.getByRole("alertdialog", {
    name: "Remove managed worktree",
  });
  await removeDialog
    .getByRole("button", { name: "Remove clean worktree" })
    .click();
  await expect(card).toContainText("removed");
  await card.getByRole("button", { name: "Delete merged branch" }).click();
  const branchDialog = page.getByRole("alertdialog", {
    name: "Delete removed worktree branch",
  });
  await expect(branchDialog).toContainText("Safety target");
  await branchDialog
    .getByRole("button", { name: "Delete merged branch" })
    .click();
  await expect(card).toHaveCount(0);

  await expect(
    page
      .getByRole("navigation", { name: "Workspaces" })
      .getByRole("button", { name: "Feature work", exact: true }),
  ).toHaveCount(0);
});
