import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  session,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { createDaemonLog, type DaemonLogSink } from "./daemon-log.js";
import {
  assertDesktopRuntimePaths,
  resolveDesktopRuntimePaths,
} from "./runtime-paths.js";
import {
  requestDesktopRebootstrap,
  validateBootstrapUrl,
  waitForDaemonHealth,
} from "./reauth.js";

const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const PRELOAD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "preload.cjs",
);

interface OwnedDaemonProcess {
  child: ChildProcessWithoutNullStreams;
  bootstrapDirectory: string;
  closed: Promise<void>;
  log: DaemonLogSink;
  controlToken: string;
}

interface DaemonProcess extends OwnedDaemonProcess {
  bootstrapUrl: string;
  origin: string;
}

let mainWindow: BrowserWindow | undefined;
let ownedDaemon: DaemonProcess | undefined;
let activeRuntime: DaemonProcess | undefined;
let shutdownPromise: Promise<void> | undefined;
let recoveryPromise: Promise<void> | undefined;
const terminationPromises = new WeakMap<OwnedDaemonProcess, Promise<void>>();
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

function createControlToken(): string {
  return randomBytes(32).toString("base64url");
}

async function startDaemon(): Promise<DaemonProcess> {
  const forwardedArguments = desktopArguments();
  validateDesktopArguments(forwardedArguments);

  const bootstrapDirectory = mkdtempSync(join(tmpdir(), "pi-dash-desktop-"));
  chmodSync(bootstrapDirectory, 0o700);
  const bootstrapOutput = join(bootstrapDirectory, "bootstrap-url");
  const controlToken = createControlToken();
  const daemonLog = createDaemonLog();
  const runtime = resolveDesktopRuntimePaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleUrl: import.meta.url,
    env: process.env,
  });
  try {
    assertDesktopRuntimePaths(runtime);
  } catch (error) {
    daemonLog.write(
      "desktop",
      `Packaged runtime validation failed: ${(error as Error).message}\n`,
    );
    daemonLog.close();
    rmSync(bootstrapDirectory, { recursive: true, force: true });
    throw new Error(
      `The Pi Dash application resources are incomplete: ${(error as Error).message}`,
    );
  }
  daemonLog.write(
    "desktop",
    `Starting daemon with executable ${runtime.nodeExecutable}\n`,
  );
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(
      runtime.nodeExecutable,
      [
        runtime.serverEntry,
        ...forwardedArguments,
        "--no-open",
        "--static-dir",
        runtime.staticDirectory,
        "--bootstrap-output",
        bootstrapOutput,
      ],
      {
        cwd: runtime.resourceRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PI_DASH_RESOURCE_ROOT: runtime.resourceRoot,
          PI_DASH_DESKTOP: "true",
          PI_DASH_DESKTOP_CONTROL_TOKEN: controlToken,
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
  const ownership: DaemonProcess = {
    child,
    bootstrapDirectory,
    closed,
    log: daemonLog,
    controlToken,
    bootstrapUrl: "",
    origin: "",
  };
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
    ownership.bootstrapUrl = launch.url;
    ownership.origin = launch.origin;
    return ownership;
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

function terminateDaemon(current: OwnedDaemonProcess): Promise<void> {
  const existing = terminationPromises.get(current);
  if (existing) return existing;
  const pending = (async () => {
    try {
      if (current.child.exitCode === null) {
        try {
          current.child.kill("SIGTERM");
        } catch {
          // The process may already be gone.
        }
        if (!(await waitForClose(current.closed, SHUTDOWN_TIMEOUT_MS))) {
          try {
            current.child.kill("SIGKILL");
          } catch {
            // The process may already be gone.
          }
          await waitForClose(current.closed, 2_000);
        }
      } else {
        await current.closed;
      }
    } finally {
      current.log.close();
      rmSync(current.bootstrapDirectory, { recursive: true, force: true });
    }
  })().finally(() => {
    if (terminationPromises.get(current) === pending) {
      terminationPromises.delete(current);
    }
  });
  terminationPromises.set(current, pending);
  return pending;
}

async function stopDaemon(): Promise<void> {
  const current = ownedDaemon;
  ownedDaemon = undefined;
  activeRuntime = undefined;
  if (current) await terminateDaemon(current);
}

function daemonChildAlive(runtime: DaemonProcess): boolean {
  return !runtime.child.killed && runtime.child.exitCode === null;
}

type RecoveryStatus = "retrying" | "recovered" | "restarting";

function sendRecoveryStatus(status: RecoveryStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("pi-dash:recovery-status", status);
}

function attachDaemonExitRecovery(runtime: DaemonProcess): void {
  runtime.child.once("close", () => {
    if (quitting || ownedDaemon !== runtime) return;
    void recoverDaemon("The local daemon exited unexpectedly.").catch(
      (error: unknown) => {
        dialog.showErrorBox(
          "Pi Dash daemon stopped",
          [
            "The local daemon exited unexpectedly and could not be restarted.",
            (error as Error).message,
            runtime.log.failure
              ? `Diagnostic logging was unavailable: ${runtime.log.failure}`
              : `Diagnostic log: ${runtime.log.path}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        app.quit();
      },
    );
  });
}

async function loadBootstrap(url: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("The Pi Dash window is unavailable");
  }
  await mainWindow.loadURL(url);
}

async function requestAndLoadBootstrap(runtime: DaemonProcess): Promise<void> {
  const bootstrapUrl = await requestDesktopRebootstrap({
    origin: runtime.origin,
    controlToken: runtime.controlToken,
  });
  runtime.bootstrapUrl = bootstrapUrl;
  await loadBootstrap(bootstrapUrl);
}

async function runtimeWasReplaced(runtime: DaemonProcess): Promise<boolean> {
  if (activeRuntime === runtime) return false;
  if (recoveryPromise) await recoveryPromise;
  return true;
}

async function reauthenticate(): Promise<void> {
  const runtime = activeRuntime;
  if (!runtime || !daemonChildAlive(runtime)) {
    await recoverDaemon("The local daemon is unavailable.");
    return;
  }
  try {
    await requestAndLoadBootstrap(runtime);
  } catch (error) {
    if (await runtimeWasReplaced(runtime)) return;
    const healthy = await waitForDaemonHealth({ origin: runtime.origin });
    if (await runtimeWasReplaced(runtime)) return;
    if (healthy) {
      try {
        await requestAndLoadBootstrap(runtime);
        return;
      } catch {
        if (await runtimeWasReplaced(runtime)) return;
        // A responsive daemon that cannot reauthenticate must be replaced.
      }
    }
    await recoverDaemon(
      `Desktop reauthentication failed: ${(error as Error).message}`,
    );
  }
}

async function performDaemonRecovery(reason: string): Promise<void> {
  const previous = ownedDaemon;
  activeRuntime = undefined;
  if (previous) {
    previous.log.write("desktop", `${reason}\n`);
    await terminateDaemon(previous).catch(() => undefined);
    if (ownedDaemon === previous) ownedDaemon = undefined;
  }
  if (quitting) return;
  const runtime = await startDaemon();
  if (quitting) {
    if (ownedDaemon === runtime) ownedDaemon = undefined;
    await terminateDaemon(runtime);
    return;
  }
  activeRuntime = runtime;
  attachDaemonExitRecovery(runtime);
  configureClipboardPermissions(runtime.origin);
  if (mainWindow && !mainWindow.isDestroyed()) {
    await loadBootstrap(runtime.bootstrapUrl);
  } else {
    mainWindow = createWindow(runtime);
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  }
  sendRecoveryStatus("recovered");
}

function recoverDaemon(reason: string): Promise<void> {
  if (quitting) return Promise.resolve();
  if (recoveryPromise) return recoveryPromise;
  sendRecoveryStatus("restarting");
  const pending = performDaemonRecovery(reason).finally(() => {
    if (recoveryPromise === pending) recoveryPromise = undefined;
  });
  recoveryPromise = pending;
  return pending;
}

async function ensureDaemonAfterResume(): Promise<void> {
  if (quitting) return;
  if (recoveryPromise) {
    await recoveryPromise;
    return;
  }
  const runtime = activeRuntime;
  if (!runtime || !daemonChildAlive(runtime)) {
    await recoverDaemon("The local daemon was not running after resume.");
    return;
  }
  let retrying = false;
  const healthy = await waitForDaemonHealth({
    origin: runtime.origin,
    onRetrying() {
      retrying = true;
      sendRecoveryStatus("retrying");
    },
  });
  if (await runtimeWasReplaced(runtime)) return;
  if (healthy) {
    if (retrying) sendRecoveryStatus("recovered");
    return;
  }
  await recoverDaemon("The local daemon did not respond after resume.");
}

function configureClipboardPermissions(origin: string): void {
  const clipboardPermission = (
    webContents: WebContents | null,
    permission: string,
    requestingUrl: string,
    isMainFrame: boolean,
  ): boolean => {
    let trustedOrigin = false;
    try {
      trustedOrigin = new URL(requestingUrl).origin === origin;
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
      preload: PRELOAD_PATH,
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
      if (new URL(navigationUrl).origin === activeRuntime?.origin) return;
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
  activeRuntime = runtime;
  configureClipboardPermissions(runtime.origin);
  attachDaemonExitRecovery(runtime);
  mainWindow = createWindow(runtime);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

function validateReauthenticationSender(event: IpcMainInvokeEvent): void {
  const window = mainWindow;
  const runtime = activeRuntime;
  const frame = event.senderFrame;
  let trustedOrigin = false;
  try {
    trustedOrigin =
      !!runtime && new URL(frame?.url ?? "").origin === runtime.origin;
  } catch {
    // Reject malformed sender URLs below.
  }
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    frame !== window.webContents.mainFrame ||
    !trustedOrigin
  ) {
    throw new Error("Desktop reauthentication is unavailable to this sender");
  }
}

ipcMain.handle("pi-dash:reauthenticate", async (event) => {
  validateReauthenticationSender(event);
  await reauthenticate();
});

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
    .then(async () => {
      await launch();
      powerMonitor.on("resume", () => {
        void ensureDaemonAfterResume().catch((error: unknown) => {
          if (quitting) return;
          dialog.showErrorBox(
            "Pi Dash failed to recover",
            (error as Error).message,
          );
          app.quit();
        });
      });
    })
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
