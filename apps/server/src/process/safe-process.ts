import { spawn } from "node:child_process";

export type ProcessFailureReason =
  "spawn" | "timeout" | "aborted" | "output_limit";

export class ProcessExecutionError extends Error {
  constructor(
    readonly reason: ProcessFailureReason,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProcessExecutionError";
  }
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdin?: string | Buffer;
}

export type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export const runProcess: ProcessRunner = async (
  executable,
  args,
  options,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProcessExecutionError("aborted", "Process was cancelled"));
      return;
    }

    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let outputBytes = 0;
    let failure: ProcessExecutionError | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let settled = false;

    const terminate = (nextFailure: ProcessExecutionError) => {
      if (failure) return;
      failure = nextFailure;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
    };
    const capture = (target: Buffer[]) => (chunk: Buffer | string) => {
      if (failure) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminate(
          new ProcessExecutionError(
            "output_limit",
            `Process output exceeded ${maxOutputBytes} bytes`,
          ),
        );
        return;
      }
      target.push(buffer);
    };

    child.stdout!.on("data", capture(stdout));
    child.stderr!.on("data", capture(stderr));
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        // The process result remains authoritative when it closes stdin early.
      });
      child.stdin.end(options.stdin);
    }

    const timeout = setTimeout(
      () =>
        terminate(new ProcessExecutionError("timeout", "Process timed out")),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timeout.unref();

    const abort = () =>
      terminate(new ProcessExecutionError("aborted", "Process was cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        failure ??
          new ProcessExecutionError("spawn", "Unable to start process", error),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) {
        reject(failure);
        return;
      }
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
