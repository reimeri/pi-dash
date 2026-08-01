import { homedir } from "node:os";
import type { NativeDialogAdapter } from "@pi-dash/contracts";
import { resolveExecutable } from "../process/executable.js";
import {
  ProcessExecutionError,
  runProcess,
  type ProcessRunner,
} from "../process/safe-process.js";

export type NativeDialogMode = "auto" | "zenity" | "kdialog" | "disabled";

export interface NativeDirectoryDialogProbe {
  available: boolean;
  adapter?: NativeDialogAdapter;
  reason?: string;
}

export interface NativeDirectoryDialog {
  probe(): Promise<NativeDirectoryDialogProbe>;
  chooseDirectory(options: {
    signal: AbortSignal;
  }): Promise<{ cancelled: boolean; path?: string }>;
}

export class DialogBusyError extends Error {
  constructor() {
    super("Another native directory dialog is already active");
    this.name = "DialogBusyError";
  }
}

export class DialogUnavailableError extends Error {
  constructor(message = "No supported native directory dialog is available") {
    super(message);
    this.name = "DialogUnavailableError";
  }
}

export class DialogFailureError extends Error {
  constructor(message = "The native directory dialog failed") {
    super(message);
    this.name = "DialogFailureError";
  }
}

function dialogEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
    DISPLAY: env.DISPLAY,
    WAYLAND_DISPLAY: env.WAYLAND_DISPLAY,
    XAUTHORITY: env.XAUTHORITY,
    XDG_CURRENT_DESKTOP: env.XDG_CURRENT_DESKTOP,
    XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
  };
}

class LinuxDialogAdapter implements NativeDirectoryDialog {
  constructor(
    readonly name: NativeDialogAdapter,
    private readonly executable: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly runner: ProcessRunner,
  ) {}

  async probe(): Promise<NativeDirectoryDialogProbe> {
    return { available: true, adapter: this.name };
  }

  async chooseDirectory(options: {
    signal: AbortSignal;
  }): Promise<{ cancelled: boolean; path?: string }> {
    const args =
      this.name === "zenity"
        ? ["--file-selection", "--directory"]
        : ["--getexistingdirectory"];
    let result;
    try {
      result = await this.runner(this.executable, args, {
        cwd: this.env.HOME || homedir(),
        env: dialogEnvironment(this.env),
        signal: options.signal,
        timeoutMs: 2 * 60_000,
        maxOutputBytes: 16 * 1024,
      });
    } catch (error) {
      if (
        error instanceof ProcessExecutionError &&
        error.reason === "aborted"
      ) {
        throw error;
      }
      throw new DialogFailureError(
        error instanceof ProcessExecutionError && error.reason === "timeout"
          ? "The native directory dialog timed out"
          : undefined,
      );
    }

    if (result.exitCode === 0) {
      const path = result.stdout.endsWith("\n")
        ? result.stdout.slice(0, -1)
        : result.stdout;
      if (!path || path.includes("\0")) throw new DialogFailureError();
      return { cancelled: false, path };
    }
    if (result.exitCode === 1) return { cancelled: true };
    throw new DialogFailureError();
  }
}

export interface NativeDirectoryDialogService {
  probe(): Promise<NativeDirectoryDialogProbe>;
  chooseDirectory(options: { signal?: AbortSignal }): Promise<{
    cancelled: boolean;
    path?: string;
    adapter: NativeDialogAdapter;
  }>;
  close(): void;
}

class DialogCoordinator implements NativeDirectoryDialogService {
  private active = false;
  private readonly shutdownController = new AbortController();

  constructor(
    private readonly capability: NativeDirectoryDialogProbe,
    private readonly adapter?: LinuxDialogAdapter,
  ) {}

  async probe(): Promise<NativeDirectoryDialogProbe> {
    return this.capability;
  }

  async chooseDirectory(options: { signal?: AbortSignal }): Promise<{
    cancelled: boolean;
    path?: string;
    adapter: NativeDialogAdapter;
  }> {
    if (!this.adapter || !this.capability.adapter) {
      throw new DialogUnavailableError(this.capability.reason);
    }
    if (this.active) throw new DialogBusyError();
    if (options.signal?.aborted || this.shutdownController.signal.aborted) {
      throw new ProcessExecutionError("aborted", "Process was cancelled");
    }
    this.active = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.shutdownController.signal.addEventListener("abort", abort, {
      once: true,
    });
    try {
      const result = await this.adapter.chooseDirectory({
        signal: controller.signal,
      });
      return { ...result, adapter: this.capability.adapter };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.shutdownController.signal.removeEventListener("abort", abort);
      this.active = false;
    }
  }

  close(): void {
    this.shutdownController.abort();
  }
}

export async function createNativeDirectoryDialog(options: {
  mode: NativeDialogMode;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
}): Promise<NativeDirectoryDialogService> {
  const env = options.env ?? process.env;
  if (options.mode === "disabled") {
    return new DialogCoordinator({
      available: false,
      reason: "Native directory dialogs are disabled by configuration",
    });
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return new DialogCoordinator({
      available: false,
      reason: "No graphical display session is available",
    });
  }

  const candidates: NativeDialogAdapter[] =
    options.mode === "auto" ? ["zenity", "kdialog"] : [options.mode];
  for (const name of candidates) {
    const executable = await resolveExecutable(name, env.PATH);
    if (!executable) continue;
    const adapter = new LinuxDialogAdapter(
      name,
      executable,
      env,
      options.runner ?? runProcess,
    );
    return new DialogCoordinator({ available: true, adapter: name }, adapter);
  }
  return new DialogCoordinator({
    available: false,
    reason: `Could not find ${candidates.join(" or ")} in PATH`,
  });
}
