import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VERSION_PATTERN = /(?:^|\s|v)(\d+\.\d+\.\d+)(?:\s|$)/;

export type PiResolutionErrorCode = "PI_UNAVAILABLE" | "PI_VERSION_UNSUPPORTED";

export class PiResolutionError extends Error {
  constructor(
    readonly code: PiResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PiResolutionError";
  }
}

export interface ResolvedPi {
  executable: string;
  version: string;
  extensionPath: string;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function resolveExecutable(
  candidate: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const candidates = candidate.includes("/")
    ? [isAbsolute(candidate) ? candidate : resolve(candidate)]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, candidate));
  for (const path of candidates) {
    try {
      const canonical = await realpath(path);
      await access(canonical, fsConstants.X_OK);
      return canonical;
    } catch {
      // Continue through PATH without exposing host paths in the API error.
    }
  }
  throw new PiResolutionError(
    "PI_UNAVAILABLE",
    "The configured Pi executable was not found or is not executable",
  );
}

export function resolveDashboardExtensionPath(): string {
  return fileURLToPath(import.meta.resolve("@pi-dash/pi-extension/runtime"));
}

export function createPiResolver(options: {
  executable: string;
  minimumVersion: string;
  env?: NodeJS.ProcessEnv;
  extensionPath?: string;
  timeoutMs?: number;
}) {
  const env = options.env ?? process.env;
  const extensionPath =
    options.extensionPath ?? resolveDashboardExtensionPath();
  const minimumMatch = options.minimumVersion.match(/^\d+\.\d+\.\d+$/);
  if (!minimumMatch)
    throw new Error("Pi minimum version must use major.minor.patch");

  const probeEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("PI_DASH_")) probeEnv[key] = value;
  }

  return {
    async probe(): Promise<ResolvedPi> {
      const executable = await resolveExecutable(options.executable, probeEnv);
      let output: string;
      try {
        const result = await execFileAsync(executable, ["--version"], {
          env: probeEnv,
          encoding: "utf8",
          timeout: options.timeoutMs ?? 5_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
        });
        output = `${result.stdout}\n${result.stderr}`;
      } catch {
        throw new PiResolutionError(
          "PI_UNAVAILABLE",
          "The configured Pi executable did not complete its version probe",
        );
      }
      const version = output.match(VERSION_PATTERN)?.[1];
      if (!version || compareVersions(version, options.minimumVersion) < 0) {
        throw new PiResolutionError(
          "PI_VERSION_UNSUPPORTED",
          `Pi ${options.minimumVersion} or newer is required`,
        );
      }
      try {
        await access(extensionPath, fsConstants.R_OK);
      } catch {
        throw new PiResolutionError(
          "PI_UNAVAILABLE",
          "The packaged Pi Dash extension resource is unavailable",
        );
      }
      return { executable, version, extensionPath };
    },
  };
}

export type PiResolver = ReturnType<typeof createPiResolver>;
