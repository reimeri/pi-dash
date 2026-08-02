import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  session,
  type WebContents,
} from "electron";
import {
  createDaemonLog,
  type DaemonLogSink,
  sanitizeDaemonOutput,
} from "./daemon-log.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const serverEntry = join(repositoryRoot, "apps/server/dist/cli.js");
const staticDirectory = join(repositoryRoot, "apps/web/dist");
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

interface OwnedDaemonProcess {
  child: ChildProcessWithoutNullStreams;
  bootstrapDirectory: string;
  closed: Promise<void>;
  log: DaemonLogSink;
}

interface DaemonProcess extends OwnedDaemonProcess {
  bootstrapUrl: string;
  origin: string;
}

let mainWindow: BrowserWindow | undefined;
let ownedDaemon: OwnedDaemonProcess | undefined;
let shutdownPromise: Promise<void> | undefined;
let quitting = false;

function desktopArguments(): string[] {
  return process.argv.slice(app.isPackaged ? 1 : 2);
}

function validateDesktopArguments(args: readonly string[]): void {
  const reserved = ["--bootstrap-output", "--static-dir", "--ui-origin"];
  for (const argument of args) {
    if (
      reserved.some(
        (name) => argument === name || argument.startsWith(`${name}=`),
      )
    ) {
      throw new Error(
        `${argument.split("=", 1)[0]} is managed by Pi Dash Desktop`,
      );
    }
  }
}

function validateBootstrapUrl(rawUrl: string): { url: string; origin: string } {
  const url = new URL(rawUrl);
  const loopback =
    url.hostname === "::1" ||
    (url.hostname.startsWith("127.") &&
      url.hostname.split(".").every((part) => /^\d+$/.test(part)));
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.pathname !== "/auth/bootstrap" ||
    !url.searchParams.has("token")
  ) {
    throw new Error("The daemon returned an invalid desktop launch URL");
  }
  return { url: url.href, origin: url.origin };
}

function sanitizedFailure(message: string, maxCharacters = 8_192): string {
  return sanitizeDaemonOutput(message).trim().slice(-maxCharacters);
}

async function startDaemon(): Promise<DaemonProcess> {
  const forwardedArguments = desktopArguments();
  validateDesktopArguments(forwardedArguments);

  const bootstrapDirectory = mkdtempSync(join(tmpdir(), "pi-dash-desktop-"));
  chmodSync(bootstrapDirectory, 0o700);
  const bootstrapOutput = join(bootstrapDirectory, "bootstrap-url");
  const daemonLog = createDaemonLog();
  const nodeExecutable = process.env.PI_DASH_NODE_EXECUTABLE?.trim() || "node";
  daemonLog.write(
    "desktop",
    `Starting daemon with executable ${nodeExecutable}\n`,
  );
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      nodeExecutable,
      [
        serverEntry,
        ...forwardedArguments,
        "--no-open",
        "--static-dir",
        staticDirectory,
        "--bootstrap-output",
        bootstrapOutput,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PI_DASH_DESKTOP: "true",
          PI_DASH_NO_OPEN: "true",
          PI_DASH_UI_ORIGIN: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (error) {
    daemonLog.write(
      "desktop",
      `Unable to spawn daemon: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    daemonLog.close();
    rmSync(bootstrapDirectory, { recursive: true, force: true });
    throw error;
  }
  child.stdin.end();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const ownership = { child, bootstrapDirectory, closed, log: daemonLog };
  ownedDaemon = ownership;

  child.stdout.on("data", (chunk: Buffer) => daemonLog.write("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => daemonLog.write("stderr", chunk));
  child.on("error", (error) => {
    daemonLog.write(
      "desktop",
      `Daemon process error: ${error.stack ?? error}\n`,
    );
  });
  child.once("close", (code, signal) => {
    daemonLog.write(
      "desktop",
      `Daemon exited (${signal ?? code ?? "unknown"})\n`,
    );
    daemonLog.close();
    resolveClosed();
  });

  try {
    const rawUrl = await new Promise<string>((resolve, reject) => {
      let stdoutBuffer = "";
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error("Timed out while starting the Pi Dash daemon"));
      }, STARTUP_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout.off("data", handleStdout);
        child.off("error", handleError);
        child.off("close", handleClose);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(readFileSync(bootstrapOutput, "utf8").trim());
        } catch (error) {
          reject(
            new Error(
              `Unable to read the daemon launch URL: ${(error as Error).message}`,
            ),
          );
        }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const handleStdout = (chunk: Buffer) => {
        stdoutBuffer = `${stdoutBuffer}${chunk.toString("utf8")}`.slice(
          -32_768,
        );
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        if (lines.some((line) => line.startsWith("Open Pi Dash: "))) succeed();
      };
      const handleError = (error: Error) => fail(error);
      const handleClose = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        const detail = daemonLog.tail();
        fail(
          new Error(
            `Pi Dash daemon exited before startup (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
          ),
        );
      };

      child.stdout.on("data", handleStdout);
      child.once("error", handleError);
      child.once("close", handleClose);
    });
    const launch = validateBootstrapUrl(rawUrl);
    return {
      child,
      bootstrapDirectory,
      closed,
      log: daemonLog,
      bootstrapUrl: launch.url,
      origin: launch.origin,
    };
  } catch (error) {
    if (ownedDaemon === ownership) ownedDaemon = undefined;
    await terminateDaemon(ownership);
    throw error;
  }
}

function waitForClose(
  closed: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void closed.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function terminateDaemon(current: OwnedDaemonProcess): Promise<void> {
  try {
    current.child.kill("SIGTERM");
    if (!(await waitForClose(current.closed, SHUTDOWN_TIMEOUT_MS))) {
      current.child.kill("SIGKILL");
      await waitForClose(current.closed, 2_000);
    }
  } finally {
    current.log.close();
    rmSync(current.bootstrapDirectory, { recursive: true, force: true });
  }
}

async function stopDaemon(): Promise<void> {
  const current = ownedDaemon;
  ownedDaemon = undefined;
  if (current) await terminateDaemon(current);
}

function createWindow(runtime: DaemonProcess): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#09090b",
    title: "Pi Dash",
    webPreferences: {
      contextIsolation: true,
      devTools: false,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setIgnoreMenuShortcuts(true);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("will-navigate", (event, navigationUrl) => {
    try {
      if (new URL(navigationUrl).origin === runtime.origin) return;
    } catch {
      // Deny malformed and non-HTTP navigation below.
    }
    event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(runtime.bootstrapUrl).catch((error: unknown) => {
    dialog.showErrorBox("Pi Dash failed to load", (error as Error).message);
    app.quit();
  });
  return window;
}

async function launch(): Promise<void> {
  Menu.setApplicationMenu(null);
  const runtime = await startDaemon();
  if (quitting) return;
  const clipboardPermission = (
    webContents: WebContents | null,
    permission: string,
    requestingUrl: string,
    isMainFrame: boolean,
  ): boolean => {
    let trustedOrigin = false;
    try {
      trustedOrigin = new URL(requestingUrl).origin === runtime.origin;
    } catch {
      // Reject malformed requesting URLs below.
    }
    return (
      webContents === mainWindow?.webContents &&
      trustedOrigin &&
      isMainFrame &&
      permission === "clipboard-sanitized-write"
    );
  };
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        clipboardPermission(
          webContents,
          permission,
          details.requestingUrl,
          details.isMainFrame,
        ),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      clipboardPermission(
        webContents,
        permission,
        details.requestingUrl ?? requestingOrigin,
        details.isMainFrame,
      ),
  );
  runtime.child.once("close", (code, signal) => {
    if (quitting) return;
    const detail = runtime.log.tail(4_000);
    dialog.showErrorBox(
      "Pi Dash daemon stopped",
      [
        `The local daemon exited unexpectedly (${signal ?? code ?? "unknown"}).`,
        detail
          ? `Final diagnostic output:\n${sanitizedFailure(detail, 2_000)}`
          : "",
        runtime.log.failure
          ? `Diagnostic logging was unavailable: ${runtime.log.failure}`
          : `Diagnostic log: ${runtime.log.path}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    app.quit();
  });
  mainWindow = createWindow(runtime);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

app.enableSandbox();
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    shutdownPromise ??= stopDaemon();
    void shutdownPromise.finally(() => app.exit());
  });
  void app
    .whenReady()
    .then(launch)
    .catch((error: unknown) => {
      if (!quitting) {
        dialog.showErrorBox(
          "Pi Dash failed to start",
          (error as Error).message,
        );
      }
      quitting = true;
      shutdownPromise ??= stopDaemon();
      void shutdownPromise.finally(() => app.exit(1));
    });
}
