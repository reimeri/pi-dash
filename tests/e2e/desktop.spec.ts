import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { createGitRepository } from "../fixtures/git-repository.js";

const port = 4324;
let root: string;
let repository: string;
let desktop: ElectronApplication;

async function openTerminal(): Promise<{
  window: Awaited<ReturnType<ElectronApplication["firstWindow"]>>;
  inputFrames: string[];
}> {
  const window = await desktop.firstWindow();
  const inputFrames: string[] = [];
  window.on("websocket", (socket) => {
    if (!socket.url().includes("/terminal/socket")) return;
    socket.on("framesent", ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as {
          type?: string;
          data?: string;
        };
        if (frame.type === "input" && typeof frame.data === "string") {
          inputFrames.push(frame.data);
        }
      } catch {
        // Binary terminal frames are not relevant to keyboard assertions.
      }
    });
  });

  await expect(window.getByRole("main")).toBeVisible();
  await window
    .getByRole("main")
    .getByRole("button", { name: "Add workspace" })
    .click();
  const workspaceDialog = window.getByRole("dialog", { name: "Add workspace" });
  await workspaceDialog.getByLabel("Repository directory").fill(repository);
  await workspaceDialog.getByRole("button", { name: "Continue" }).click();
  await workspaceDialog.getByLabel("Workspace name").fill("Desktop E2E");
  await workspaceDialog.getByRole("button", { name: "Add workspace" }).click();

  await window.getByRole("button", { name: "Create worktree" }).click();
  const worktreeDialog = window.getByRole("dialog", {
    name: "Create worktree",
  });
  await worktreeDialog.getByLabel("Name").fill("Keybindings");
  await worktreeDialog.getByRole("button", { name: "Create worktree" }).click();
  await expect(worktreeDialog).not.toBeVisible({ timeout: 15_000 });

  await window.getByRole("button", { name: "Expand Desktop E2E" }).click();
  await window
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: "Keybindings", exact: true })
    .click();
  const terminal = window.getByRole("application", {
    name: "Desktop E2E Keybindings interactive Pi terminal",
  });
  await expect(terminal).toContainText("FAKE_PI_READY", { timeout: 15_000 });
  await terminal.click();
  return { window, inputFrames };
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pi-dash-desktop-e2e-"));
  repository = createGitRepository(root, "desktop-project");
  const fakePi = resolve("tests/fixtures/fake-pi.ts");
  chmodSync(fakePi, 0o755);
  desktop = await electron.launch({
    args: [
      resolve("apps/desktop/dist/main.js"),
      "--port",
      String(port),
      "--data-dir",
      join(root, "data"),
      "--config-dir",
      join(root, "config"),
      "--runtime-dir",
      join(root, "runtime"),
      "--native-dialog",
      "disabled",
      "--pi-executable",
      fakePi,
      "--log-level",
      "warn",
    ],
    env: {
      ...process.env,
      XDG_STATE_HOME: join(root, "state"),
      FAKE_PI_STATUS: "1",
      PI_DASH_NODE_EXECUTABLE: process.execPath,
    },
  });
});

test.afterAll(async () => {
  await desktop?.close().catch(() => undefined);
  if (root) await rm(root, { recursive: true, force: true });
});

test("desktop delivers Pi keybindings instead of browser shortcuts", async () => {
  const { window, inputFrames } = await openTerminal();
  const cases: Array<[string, string]> = [
    ["Control+w", "\u0017"],
    ["Control+l", "\u000c"],
    ["Control+t", "\u0014"],
    ["Control+o", "\u000f"],
    ["Control+g", "\u0007"],
    ["Control+p", "\u0010"],
    ["Control+Shift+p", "\u001b[112;6u"],
    ["Control+k", "\u000b"],
    ["Shift+Tab", "\u001b[Z"],
    ["Alt+Enter", "\u001b[13;3u"],
    ["Alt+ArrowUp", "\u001b[1;3A"],
  ];

  for (const [shortcut, expectedData] of cases) {
    const priorCount = inputFrames.length;
    await window.keyboard.press(shortcut);
    await expect
      .poll(() => inputFrames.slice(priorCount).includes(expectedData), {
        message: `${shortcut} should reach the PTY as ${JSON.stringify(expectedData)}`,
      })
      .toBe(true);
  }

  expect(desktop.windows()).toHaveLength(1);
  await expect(
    desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every(
        (candidate) => !candidate.webContents.isDevToolsOpened(),
      ),
    ),
  ).resolves.toBe(true);

  const beforePaste = inputFrames.length;
  await window.locator(".xterm-helper-textarea").evaluate((element) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "desktop-paste");
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect
    .poll(() => inputFrames.slice(beforePaste).includes("desktop-paste"))
    .toBe(true);

  await desktop.evaluate(({ clipboard }) => clipboard.writeText("unchanged"));
  const priorCount = inputFrames.length;
  await window.keyboard.press("Control+Shift+c");
  await window.waitForTimeout(100);
  expect(inputFrames).toHaveLength(priorCount);
  await expect(
    desktop.evaluate(({ clipboard }) => clipboard.readText()),
  ).resolves.toBe("unchanged");
  expect(desktop.windows()).toHaveLength(1);

  const pastedRow = window
    .locator(".xterm-rows > div")
    .filter({ hasText: "desktop-paste" })
    .first();
  const pastedRowBox = await pastedRow.boundingBox();
  expect(pastedRowBox).not.toBeNull();
  await window.mouse.click(pastedRowBox!.x + 35, pastedRowBox!.y + 8, {
    clickCount: 2,
  });
  await window.keyboard.press("Control+Shift+c");
  await expect
    .poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain("desktop-paste");
  expect(inputFrames).toHaveLength(priorCount);
});
