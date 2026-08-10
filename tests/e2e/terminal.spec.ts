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
      env: {
        ...process.env,
        NODE_ENV: "production",
        PI_DASH_NO_OPEN: "true",
        FAKE_PI_STATUS: "1",
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

test("starts, interacts with, reconnects to, stops, and restarts a terminal", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const terminalClientFrames: Array<Record<string, unknown>> = [];
  let releaseTerminalSocket: (() => void) | undefined;
  const terminalSocketGate = new Promise<void>((resolveGate) => {
    releaseTerminalSocket = resolveGate;
  });
  page.on("pageerror", (error) =>
    pageErrors.push(error.stack ?? error.message),
  );
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/terminal/socket")) return;
    socket.on("framesent", ({ payload }) => {
      try {
        terminalClientFrames.push(JSON.parse(payload.toString()));
      } catch {
        // Binary input is not relevant to this protocol assertion.
      }
    });
  });
  await page.routeWebSocket(/\/terminal\/socket$/, async (socketRoute) => {
    const screen = page.locator(".terminal-pane:not(.hidden) .xterm-screen");
    await screen.waitFor({ state: "attached" });
    await expect
      .poll(async () => (await screen.boundingBox())?.width ?? 0)
      .toBeGreaterThan(800);
    await terminalSocketGate;
    socketRoute.connectToServer();
  });
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
    name: "Create worktree",
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
  await expect(
    page.getByRole("button", { name: "Collapse Terminal E2E" }),
  ).toBeVisible();
  const workspaceSelect = page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "Terminal E2E", exact: true });
  const workspaceActivity = workspaceSelect.getByRole("img");
  await workspaceSelect.click();
  await expect(
    page.getByRole("heading", { name: "Terminal E2E" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Terminal work" }),
  ).toBeVisible();
  const sidebarWorktree = page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "Terminal work", exact: true });
  await sidebarWorktree.click();

  const terminal = page.getByRole("application", {
    name: "Terminal E2E Terminal work interactive Pi terminal",
  });
  async function expectCollapsedWorkspaceActivity(
    accessibleName: RegExp,
  ): Promise<void> {
    await page.getByRole("button", { name: "Collapse Terminal E2E" }).click();
    await expect(workspaceActivity).toHaveAccessibleName(accessibleName);
    await page.getByRole("button", { name: "Expand Terminal E2E" }).click();
    await expect(workspaceActivity).toHaveCount(0);
  }
  const startupStatus = terminal.getByRole("status");
  await expect(startupStatus).toContainText(
    "Opening Pi terminal · Connecting to terminal…",
  );
  const [startupStatusBox, startupTerminalBox] = await Promise.all([
    startupStatus.boundingBox(),
    terminal.boundingBox(),
  ]);
  expect(startupStatusBox).not.toBeNull();
  expect(startupTerminalBox).not.toBeNull();
  expect(
    Math.abs(
      startupStatusBox!.x +
        startupStatusBox!.width / 2 -
        (startupTerminalBox!.x + startupTerminalBox!.width / 2),
    ),
  ).toBeLessThanOrEqual(2);
  expect(
    Math.abs(
      startupStatusBox!.y +
        startupStatusBox!.height / 2 -
        (startupTerminalBox!.y + startupTerminalBox!.height / 2),
    ),
  ).toBeLessThanOrEqual(2);
  releaseTerminalSocket?.();
  await expect(terminal).toContainText("FAKE_PI_READY");
  const workflowIndicator = sidebarWorktree.getByRole("img");
  await expect(workflowIndicator).toHaveAccessibleName(
    /Terminal work workflow: Idle/,
  );
  await page.getByRole("button", { name: "Collapse Terminal E2E" }).click();
  await expect(workspaceActivity).toHaveCount(0);
  await page.getByRole("button", { name: "Expand Terminal E2E" }).click();
  await terminal.click();
  await page.keyboard.type("__WORKING__");
  await expect(workflowIndicator).toHaveAccessibleName(
    /Terminal work workflow: Working/,
  );
  await expectCollapsedWorkspaceActivity(
    /Terminal E2E workflow: Running; 1 worktree with activity/,
  );
  await terminal.click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      workflowIndicator.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    )
    .toBe("none");
  await page.keyboard.type("__BLOCK_START__");
  await expect(workflowIndicator).toHaveAccessibleName(
    /Terminal work workflow: Blocked waiting for an answer/,
  );
  await expectCollapsedWorkspaceActivity(
    /Terminal E2E workflow: Needs attention; 1 worktree with activity/,
  );
  await terminal.click();
  await page.keyboard.type("__BLOCK_END__");
  await expect(workflowIndicator).toHaveAccessibleName(
    /Terminal work workflow: Working/,
  );
  await page.keyboard.type("__SETTLED__");
  await expect(workflowIndicator).toHaveAccessibleName(
    /Terminal work workflow: Done, acknowledgement required/,
  );
  await expectCollapsedWorkspaceActivity(
    /Terminal E2E workflow: All done; 1 completion awaiting acknowledgement/,
  );
  await expect
    .poll(() =>
      terminalClientFrames.some(
        (frame) => frame.type === "resize" && Number(frame.cols) > 80,
      ),
    )
    .toBe(true);
  await expect
    .poll(async () => {
      const contents = (await terminal.textContent()) ?? "";
      return [...contents.matchAll(/FAKE_PI_SIZE (\d+)x\d+/g)].some(
        (match) => Number(match[1]) > 80,
      );
    })
    .toBe(true);
  await expect(page.getByRole("heading", { name: "Terminal E2E" })).toHaveCount(
    0,
  );
  const terminalPane = terminal.locator("..");
  const main = page.getByRole("main");
  const [terminalBox, mainBox] = await Promise.all([
    terminalPane.boundingBox(),
    main.boundingBox(),
  ]);
  expect(terminalBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  expect(Math.abs(terminalBox!.width - mainBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(terminalBox!.height - mainBox!.height)).toBeLessThanOrEqual(
    1,
  );

  const terminalDimensions = await terminal.evaluate((region) => {
    const emulator = region.querySelector<HTMLElement>(
      '[data-testid="terminal-emulator"]',
    );
    const xterm = region.querySelector<HTMLElement>(".xterm");
    const screen = region.querySelector<HTMLElement>(".xterm-screen");
    if (!emulator || !xterm || !screen) return undefined;

    const regionStyle = getComputedStyle(region);
    return {
      availableHeight:
        region.clientHeight -
        Number.parseFloat(regionStyle.paddingTop) -
        Number.parseFloat(regionStyle.paddingBottom),
      availableWidth:
        region.clientWidth -
        Number.parseFloat(regionStyle.paddingLeft) -
        Number.parseFloat(regionStyle.paddingRight),
      emulatorHeight: emulator.getBoundingClientRect().height,
      emulatorWidth: emulator.getBoundingClientRect().width,
      screenWidth: screen.getBoundingClientRect().width,
      xtermHeight: xterm.getBoundingClientRect().height,
      xtermWidth: xterm.getBoundingClientRect().width,
    };
  });
  expect(terminalDimensions).toBeDefined();
  expect(
    Math.abs(
      terminalDimensions!.emulatorHeight - terminalDimensions!.availableHeight,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      terminalDimensions!.xtermHeight - terminalDimensions!.availableHeight,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      terminalDimensions!.emulatorWidth - terminalDimensions!.availableWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      terminalDimensions!.xtermWidth - terminalDimensions!.availableWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      terminalDimensions!.availableWidth - terminalDimensions!.screenWidth,
    ),
  ).toBeLessThan(32);

  await page.getByRole("button", { name: "Open shell terminal" }).click();
  const shell = page.getByRole("application", {
    name: "Terminal E2E Terminal work interactive shell terminal",
  });
  await expect(shell).toBeVisible();
  await expect
    .poll(async () => ((await shell.textContent()) ?? "").trim().length)
    .toBeGreaterThan(0);
  await shell.click();
  await page.keyboard.type("export PI_DASH_SHELL_TEST=persisted");
  await page.keyboard.press("Enter");
  await page.keyboard.type(
    "printf '__SHELL_READY__:%s\\n' \"$PI_DASH_SHELL_TEST\"",
  );
  await page.keyboard.press("Enter");
  await expect(shell).toContainText("__SHELL_READY__:persisted");
  await page.keyboard.type("sleep 3");
  await page.keyboard.press("Enter");
  const activeShellWorktree = page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", {
      name: /Terminal work, terminal command running/,
    });
  await expect(activeShellWorktree).toBeVisible();
  await page.getByRole("button", { name: /View changes/ }).click();
  await expect(shell).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Changes", exact: true }),
  ).toBeVisible();
  await expect(activeShellWorktree).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open shell terminal, command running",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open shell terminal, command running" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Changes", exact: true }),
  ).toHaveCount(0);
  await expect(shell).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close shell terminal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close shell terminal" }).click();
  await expect(terminal).toBeVisible();
  await expect
    .poll(async () =>
      page
        .getByRole("navigation", { name: "Workspaces" })
        .getByRole("button", { name: "Terminal work", exact: true })
        .count(),
    )
    .toBe(1);
  await page.getByRole("button", { name: "Open shell terminal" }).click();
  await expect(shell).toContainText("__SHELL_READY__:persisted");
  await shell.click();
  await page.keyboard.type(
    "printf '__SHELL_REOPEN__:%s\\n' \"$PI_DASH_SHELL_TEST\"",
  );
  await page.keyboard.press("Enter");
  await expect(shell).toContainText("__SHELL_REOPEN__:persisted");
  await page.getByRole("button", { name: "Close shell terminal" }).click();

  const cookieHeader = (await page.context().cookies())
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  async function wrongOriginStatus(
    route: "terminal" | "shell-terminal",
  ): Promise<number> {
    return new Promise<number>((resolveStatus, reject) => {
      const rejected = new WebSocket(
        `ws://127.0.0.1:${port}/api/v1/worktrees/${createdWorktree.id}/${route}/socket`,
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
    });
  }
  await expect(wrongOriginStatus("terminal")).resolves.toBe(403);
  await expect(wrongOriginStatus("shell-terminal")).resolves.toBe(403);

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

  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const terminalControls = page.getByLabel("Terminal controls");
  await terminalControls
    .getByRole("button", { name: "Acknowledge done" })
    .click();
  await expect(workflowIndicator).toHaveAccessibleName(
    /Terminal work workflow: Idle/,
  );
  await expect(terminalControls).toContainText("running");
  await expect(terminalControls).toContainText("connected");
  await expect(terminalControls).toContainText("Interactive");
  await page.keyboard.press("Escape");
  await expect(terminalControls).not.toBeVisible();
  await terminal.click();
  await page.keyboard.type("echo-terminal");
  await expect(terminal).toContainText("echo-terminal");

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Select a workspace" }),
  ).toBeVisible();
  await sidebarWorktree.click();
  await expect(terminal).toContainText("echo-terminal");
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await terminalControls
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  await expect(terminalControls).toContainText("stopped");
  await terminalControls
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect(terminalControls).toContainText("running");
  await page.keyboard.press("Escape");
  await expect(terminalControls).not.toBeVisible();
  await terminal.click();
  await page.keyboard.type("after-restart");
  await expect(terminal).toContainText("after-restart");

  await page.keyboard.type("__FIRST_WORKTREE_TERMINAL__");
  await page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "New worktree in Terminal E2E" })
    .click();
  const secondCreateDialog = page.getByRole("dialog", {
    name: "Create worktree",
  });
  await secondCreateDialog.getByLabel("Name").fill("Second terminal");
  await secondCreateDialog
    .getByRole("button", { name: "Create worktree" })
    .click();

  const secondSidebarWorktree = page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "Second terminal", exact: true });
  const secondTerminal = page.getByRole("application", {
    name: "Terminal E2E Second terminal interactive Pi terminal",
  });
  await expect(secondTerminal).toContainText("FAKE_PI_READY");
  await secondTerminal.click();
  await page.keyboard.type("__SECOND_WORKTREE_TERMINAL__");
  await expect(secondTerminal).toContainText("__SECOND_WORKTREE_TERMINAL__");

  const firstPane = page.getByTestId("terminal-pane").filter({
    has: page.locator(
      '[aria-label="Terminal E2E Terminal work interactive Pi terminal"]',
    ),
  });
  const secondPane = page.getByTestId("terminal-pane").filter({
    has: page.locator(
      '[aria-label="Terminal E2E Second terminal interactive Pi terminal"]',
    ),
  });
  async function expectActiveTerminal(
    activePane: typeof firstPane,
    inactivePane: typeof firstPane,
  ): Promise<void> {
    await expect(page.getByTestId("terminal-pane")).toHaveCount(2);
    await expect(activePane).toBeVisible();
    await expect(activePane).toHaveClass(/(^|\s)flex(\s|$)/);
    await expect(activePane).not.toHaveClass(/(^|\s)hidden(\s|$)/);
    await expect(inactivePane).toBeHidden();
    await expect(inactivePane).toHaveClass(/(^|\s)hidden(\s|$)/);
    await expect(inactivePane).not.toHaveClass(/(^|\s)flex(\s|$)/);
  }

  await expectActiveTerminal(secondPane, firstPane);
  await sidebarWorktree.click();
  await expectActiveTerminal(firstPane, secondPane);
  await expect(terminal).toContainText("__FIRST_WORKTREE_TERMINAL__");
  await expect(terminal).not.toContainText("__SECOND_WORKTREE_TERMINAL__");

  await secondSidebarWorktree.click();
  await expectActiveTerminal(secondPane, firstPane);
  await expect(secondTerminal).toContainText("__SECOND_WORKTREE_TERMINAL__");
  await expect(secondTerminal).not.toContainText("__FIRST_WORKTREE_TERMINAL__");
});
