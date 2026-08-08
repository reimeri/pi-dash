import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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

test("keeps the selected worktree visible while its workspace is collapsed", async ({
  page,
}) => {
  const suffix = randomUUID();
  const workspaceName = `Expand E2E ${suffix}`;
  const expandableRepository = createGitRepository(
    root,
    `expand-project-${suffix}`,
  );

  await page.goto(bootstrapUrl);
  await page
    .getByRole("main")
    .getByRole("button", { name: "Add workspace" })
    .click();
  const workspaceDialog = page.getByRole("dialog", { name: "Add workspace" });
  await workspaceDialog
    .getByLabel("Repository directory")
    .fill(expandableRepository);
  await workspaceDialog.getByRole("button", { name: "Continue" }).click();
  await workspaceDialog.getByLabel("Workspace name").fill(workspaceName);
  await workspaceDialog.getByRole("button", { name: "Add workspace" }).click();

  const workspaceNavigation = page.getByRole("navigation", {
    name: "Workspaces",
  });
  await expect(
    workspaceNavigation.getByRole("button", {
      name: `Expand ${workspaceName}`,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `New worktree in ${workspaceName}` })
    .click();
  const createDialog = page.getByRole("dialog", {
    name: "Create worktree",
  });
  await createDialog.getByLabel("Name").fill("Visible worktree");
  await createDialog.getByRole("button", { name: "Create worktree" }).click();

  const collapseWorkspaceButton = workspaceNavigation.getByRole("button", {
    name: `Collapse ${workspaceName}`,
  });
  const visibleWorktreeButton = workspaceNavigation.getByRole("button", {
    name: "Visible worktree",
    exact: true,
  });
  const expandWorkspaceButton = workspaceNavigation.getByRole("button", {
    name: `Expand ${workspaceName}`,
  });
  const workspaceButton = workspaceNavigation.getByRole("button", {
    name: workspaceName,
    exact: true,
  });
  await expect(collapseWorkspaceButton).toBeVisible();
  await expect(visibleWorktreeButton).toBeVisible();

  await collapseWorkspaceButton.click();
  await expect(expandWorkspaceButton).toBeVisible();
  await expect(visibleWorktreeButton).toBeVisible();

  await workspaceButton.click();
  await expect(expandWorkspaceButton).toBeVisible();
  await expect(visibleWorktreeButton).toHaveCount(0);

  await page.reload();
  await expect(expandWorkspaceButton).toBeVisible();
  await expect(visibleWorktreeButton).toHaveCount(0);
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
    name: "Create worktree",
  });
  await expect(createDialog.getByLabel("Base")).toBeEnabled();
  await createDialog.getByLabel("Name").fill("Feature work");
  await expect(createDialog.getByText("pi-dash/feature-work")).toBeVisible();
  await createDialog.getByRole("button", { name: "Edit slug" }).click();
  await expect(createDialog.getByLabel("Slug")).toHaveValue("feature-work");
  await createDialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(
    page.getByRole("button", { name: "Open shell terminal" }),
  ).toBeVisible();
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
  await expect(removeDialog).toContainText("1 untracked changes");
  await expect(
    removeDialog.getByRole("button", { name: "Review forced removal" }),
  ).toBeVisible();
  await removeDialog.getByRole("button", { name: "Cancel" }).click();
  unlinkSync(dirt);

  execFileSync("git", ["switch", "-c", "pi-dash/e2e-switched"], {
    cwd: managedPath,
    stdio: "ignore",
  });
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  removeDialog = page.getByRole("alertdialog", {
    name: "Remove managed worktree",
  });
  await removeDialog.getByRole("button", { name: "Show details" }).click();
  await expect(removeDialog).toContainText("refs/heads/pi-dash/feature-work");
  await expect(removeDialog).toContainText("refs/heads/pi-dash/e2e-switched");
  await removeDialog
    .getByRole("button", { name: "Review forced removal" })
    .click();
  removeDialog = page.getByRole("alertdialog", {
    name: "Confirm forced removal",
  });
  const forceButton = removeDialog.getByRole("button", {
    name: "Force remove worktree",
  });
  await expect(forceButton).toBeDisabled();
  await removeDialog.getByLabel(/Type delete to confirm/).fill("delete");
  const removalResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/remove") &&
      response.request().method() === "POST",
  );
  await forceButton.click();
  const removalResponse = await removalResponsePromise;
  const removalBody = await removalResponse.json();
  expect(
    removalResponse.status(),
    `${JSON.stringify(removalResponse.request().postDataJSON())} ${JSON.stringify(removalBody)}`,
  ).toBe(200);
  await expect(
    page.getByRole("alertdialog", { name: "Worktree removed" }),
  ).toContainText("will be left untouched");
  await page
    .getByRole("alertdialog", { name: "Worktree removed" })
    .getByRole("button", { name: "Done" })
    .click();
  await expect(card).toContainText("removed");
  await card.getByRole("button", { name: "Delete merged branch" }).click();
  const branchDialog = page.getByRole("alertdialog", {
    name: "Delete removed worktree branch",
  });
  await branchDialog.getByRole("button", { name: "Details" }).click();
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
