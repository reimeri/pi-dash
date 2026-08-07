import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_FILE_COUNT = 5;
const MAX_PENDING_LINE_BYTES = 64 * 1024;
const REDACTED = "[Redacted]";
const SECRET_KEYS = new Set([
  "authorization",
  "basesnapshottoken",
  "bootstraptoken",
  "bootstrapurl",
  "cookie",
  "csrftoken",
  "desktopcontroltoken",
  "pi_dash_bootstrap_token",
  "pi_dash_desktop_control_token",
  "pi_dash_status_token",
  "sessionid",
  "statustoken",
  "token",
  "x-csrf-token",
]);

export type DaemonLogSource = "desktop" | "stderr" | "stdout";

export interface DaemonLogSink {
  readonly path: string;
  readonly failure?: string;
  write(source: DaemonLogSource, chunk: Buffer | string): void;
  tail(maxCharacters?: number): string;
  close(): void;
}

export function resolveDaemonLogDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateRoot =
    env.XDG_STATE_HOME?.trim() || resolve(homedir(), ".local", "state");
  return resolve(stateRoot, "pi-dash");
}

function redactObject(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) redactObject(entry, seen);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      (value as Record<string, unknown>)[key] = REDACTED;
    } else {
      redactObject(entry, seen);
    }
  }
}

export function sanitizeDaemonOutput(message: string): string {
  let sanitized = message;
  try {
    const parsed: unknown = JSON.parse(message);
    redactObject(parsed);
    sanitized = JSON.stringify(parsed);
  } catch {
    // Startup messages and native crash output are not necessarily JSON.
  }
  return sanitized
    .replace(/([?&]token=)[^&\s"'\\]+/gi, `$1${REDACTED}`)
    .replace(
      /(\bauthorization["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s,"'}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(\b(?:baseSnapshotToken|bootstrapToken|bootstrapUrl|cookie|csrfToken|desktopControlToken|PI_DASH_BOOTSTRAP_TOKEN|PI_DASH_DESKTOP_CONTROL_TOKEN|PI_DASH_STATUS_TOKEN|sessionId|statusToken|token|x-csrf-token)["']?\s*[:=]\s*["']?)[^&;\s,"'}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/(\bpi_dash_session=)[^;\s,"'}]+/gi, `$1${REDACTED}`);
}

function archivedPath(directory: string, index: number): string {
  return join(directory, `daemon.${index}.log`);
}

function utf8Tail(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.byteLength <= maxBytes) return buffer;
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start);
}

export class DaemonLog implements DaemonLogSink {
  readonly path: string;
  readonly #directory: string;
  readonly #maxFileBytes: number;
  readonly #fileCount: number;
  readonly #now: () => Date;
  readonly #pending = new Map<DaemonLogSource, string>();
  readonly #decoders = new Map<DaemonLogSource, StringDecoder>();
  readonly #discardingLines = new Set<DaemonLogSource>();
  failure?: string;
  #descriptor: number | undefined;
  #bytes = 0;

  constructor(options: {
    directory: string;
    maxFileBytes?: number;
    fileCount?: number;
    now?: () => Date;
  }) {
    this.#directory = options.directory;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#fileCount = options.fileCount ?? DEFAULT_FILE_COUNT;
    this.#now = options.now ?? (() => new Date());
    if (this.#maxFileBytes < 128 || this.#fileCount < 1) {
      throw new Error("Daemon log limits are invalid");
    }
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
    const directory = statSync(this.#directory);
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o777) !== 0o700 ||
      (process.getuid && directory.uid !== process.getuid())
    ) {
      throw new Error("Daemon log directory must be private and user-owned");
    }
    this.path = join(this.#directory, "daemon.log");
    this.#secureExistingFiles();
    this.#rotate();
    this.#open();
  }

  #secureExistingFiles(): void {
    const paths = [
      this.path,
      ...Array.from({ length: this.#fileCount - 1 }, (_, index) =>
        archivedPath(this.#directory, index + 1),
      ),
    ];
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const metadata = lstatSync(path);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (process.getuid && metadata.uid !== process.getuid())
      ) {
        rmSync(path, { force: true });
        continue;
      }
      chmodSync(path, 0o600);
    }
  }

  #open(): void {
    const descriptor = openSync(
      this.path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      0o600,
    );
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (process.getuid && metadata.uid !== process.getuid())
    ) {
      closeSync(descriptor);
      throw new Error("Daemon log must be a user-owned regular file");
    }
    chmodSync(this.path, 0o600);
    this.#descriptor = descriptor;
    this.#bytes = metadata.size;
  }

  #rotate(): void {
    if (this.#fileCount > 1) {
      rmSync(archivedPath(this.#directory, this.#fileCount - 1), {
        force: true,
      });
      for (let index = this.#fileCount - 2; index >= 1; index -= 1) {
        const source = archivedPath(this.#directory, index);
        if (existsSync(source)) {
          renameSync(source, archivedPath(this.#directory, index + 1));
        }
      }
    }
    if (existsSync(this.path)) {
      if (this.#fileCount === 1) rmSync(this.path, { force: true });
      else renameSync(this.path, archivedPath(this.#directory, 1));
    }
  }

  #rotateOpenFile(): void {
    if (this.#descriptor !== undefined) closeSync(this.#descriptor);
    this.#descriptor = undefined;
    this.#rotate();
    this.#open();
  }

  #writeLine(source: DaemonLogSource, line: string): void {
    if (this.#descriptor === undefined) return;
    const prefix = Buffer.from(
      `${this.#now().toISOString()} [${source}] `,
      "utf8",
    );
    const suffix = Buffer.from("\n");
    const budget = this.#maxFileBytes - prefix.byteLength - suffix.byteLength;
    const rawMessage = Buffer.from(sanitizeDaemonOutput(line), "utf8");
    let message = rawMessage;
    if (rawMessage.byteLength > budget) {
      const marker = Buffer.from("[truncated] ");
      message = Buffer.concat([
        marker,
        utf8Tail(rawMessage, Math.max(0, budget - marker.byteLength)),
      ]);
    }
    const entry = Buffer.concat([prefix, message, suffix]);
    if (
      this.#bytes > 0 &&
      this.#bytes + entry.byteLength > this.#maxFileBytes
    ) {
      this.#rotateOpenFile();
    }
    let offset = 0;
    while (offset < entry.byteLength) {
      offset += writeSync(
        this.#descriptor!,
        entry,
        offset,
        entry.byteLength - offset,
      );
    }
    this.#bytes += entry.byteLength;
  }

  write(source: DaemonLogSource, chunk: Buffer | string): void {
    if (this.#descriptor === undefined) return;
    try {
      let decoded: string;
      if (typeof chunk === "string") {
        decoded = chunk;
      } else {
        const decoder = this.#decoders.get(source) ?? new StringDecoder("utf8");
        this.#decoders.set(source, decoder);
        decoded = decoder.write(chunk);
      }
      if (this.#discardingLines.has(source)) {
        const discardedLineEnd = decoded.indexOf("\n");
        if (discardedLineEnd < 0) return;
        this.#discardingLines.delete(source);
        decoded = decoded.slice(discardedLineEnd + 1);
      }
      let pending = `${this.#pending.get(source) ?? ""}${decoded}`;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        this.#writeLine(source, pending.slice(0, newline).replace(/\r$/, ""));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending, "utf8") > MAX_PENDING_LINE_BYTES) {
        this.#writeLine(source, "[oversized line omitted]");
        pending = "";
        this.#discardingLines.add(source);
      }
      this.#pending.set(source, pending);
    } catch (error) {
      this.#disable(error);
    }
  }

  tail(maxCharacters = 8_192): string {
    try {
      const recent = [archivedPath(this.#directory, 1), this.path]
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path, "utf8"))
        .join("");
      return sanitizeDaemonOutput(recent).trim().slice(-maxCharacters);
    } catch {
      return "";
    }
  }

  #disable(error?: unknown): void {
    if (error !== undefined) {
      this.failure = sanitizeDaemonOutput(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (this.#descriptor !== undefined) {
      try {
        closeSync(this.#descriptor);
      } catch {
        // Logging failures must not interfere with desktop or daemon lifecycle.
      }
    }
    this.#descriptor = undefined;
    this.#pending.clear();
    this.#decoders.clear();
    this.#discardingLines.clear();
  }

  close(): void {
    if (this.#descriptor === undefined) return;
    try {
      for (const [source, decoder] of this.#decoders) {
        const remainder = decoder.end();
        if (remainder) {
          this.#pending.set(
            source,
            `${this.#pending.get(source) ?? ""}${remainder}`,
          );
        }
      }
      for (const [source, pending] of this.#pending) {
        if (pending) this.#writeLine(source, pending);
      }
    } catch (error) {
      this.failure = sanitizeDaemonOutput(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.#disable();
    }
  }
}

class DisabledDaemonLog implements DaemonLogSink {
  constructor(
    readonly path: string,
    readonly failure: string,
  ) {}

  write(): void {}
  tail(): string {
    return "";
  }
  close(): void {}
}

export function createDaemonLog(
  env: NodeJS.ProcessEnv = process.env,
): DaemonLogSink {
  let path = "daemon.log";
  try {
    const directory = resolveDaemonLogDirectory(env);
    path = join(directory, "daemon.log");
    return new DaemonLog({ directory });
  } catch (error) {
    const failure = sanitizeDaemonOutput(
      error instanceof Error ? error.message : String(error),
    );
    return new DisabledDaemonLog(path, failure);
  }
}
