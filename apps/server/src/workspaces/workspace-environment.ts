import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type {
  RuntimeDto,
  WorkspaceEnvironmentChangeDto,
  WorkspaceEnvironmentDto,
} from "@pi-dash/contracts";
import { createBaseTerminalEnvironment } from "../terminal/environment.js";
import type {
  WorkspaceRecord,
  WorkspaceRepository,
} from "./workspace-repository.js";

const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_VARIABLES = 512;
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_EFFECTIVE_ENVIRONMENT_BYTES = 256 * 1024;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const TERMINAL_OWNED_NAMES = new Set(["TERM", "COLORTERM"]);

type RuntimeKind = "pi" | "shell";

interface EnvironmentState {
  dto: WorkspaceEnvironmentDto;
  fingerprint: string;
  sourceSignature: string;
  values: Record<string, string>;
}

interface AppliedEnvironment {
  workspaceId: string;
  runtimeId: string;
  fingerprint: string;
}

export interface LiveWorkspaceRuntime {
  workspaceId: string;
  kind: RuntimeKind;
  runtime: RuntimeDto;
}

export class WorkspaceEnvironmentError extends Error {
  readonly code = "ENVIRONMENT_SOURCE_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceEnvironmentError";
  }
}

function closingQuote(value: string, quote: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    let escapes = 0;
    for (let prior = index - 1; prior >= 0 && value[prior] === "\\"; prior -= 1)
      escapes += 1;
    if (escapes % 2 === 0) return index;
  }
  return -1;
}

function validQuotedSuffix(value: string): boolean {
  return /^\s*(?:#.*)?$/.test(value);
}

function validateDotenvSyntax(contents: string): void {
  if (contents.includes("\0"))
    throw new WorkspaceEnvironmentError(
      "Environment files cannot contain NUL bytes",
    );
  let quote: string | undefined;
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (quote) {
      const closing = closingQuote(line, quote, 0);
      if (closing === -1) continue;
      if (!validQuotedSuffix(line.slice(closing + 1))) {
        throw new WorkspaceEnvironmentError(
          `Environment file has invalid content on line ${index + 1}`,
        );
      }
      quote = undefined;
      continue;
    }
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const assignment =
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!assignment) {
      throw new WorkspaceEnvironmentError(
        `Environment file has invalid content on line ${index + 1}`,
      );
    }
    const value = assignment[2]!;
    if (value[0] !== '"' && value[0] !== "'" && value[0] !== "`") continue;
    const closing = closingQuote(value, value[0], 1);
    if (closing === -1) {
      quote = value[0];
    } else if (!validQuotedSuffix(value.slice(closing + 1))) {
      throw new WorkspaceEnvironmentError(
        `Environment file has invalid content on line ${index + 1}`,
      );
    }
  }
  if (quote) {
    throw new WorkspaceEnvironmentError(
      "Environment file contains an unterminated quoted value",
    );
  }
}

function parseDotenv(contents: string): Record<string, string> {
  validateDotenvSyntax(contents);
  let parsedInput: Record<string, string | undefined>;
  try {
    parsedInput = parseEnv(contents);
  } catch {
    throw new WorkspaceEnvironmentError("Environment file could not be parsed");
  }
  const parsed: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsedInput)) {
    if (value === undefined) continue;
    if (!VARIABLE_NAME.test(name)) {
      throw new WorkspaceEnvironmentError(
        `Environment variable name ${name} is invalid`,
      );
    }
    if (name.startsWith("PI_DASH_")) {
      throw new WorkspaceEnvironmentError(
        "Environment files cannot define reserved PI_DASH_* variables",
      );
    }
    if (TERMINAL_OWNED_NAMES.has(name)) {
      throw new WorkspaceEnvironmentError(
        `Environment files cannot define terminal-owned ${name}`,
      );
    }
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
      throw new WorkspaceEnvironmentError(
        `Environment variable ${name} exceeds the 64 KiB limit`,
      );
    }
    parsed[name] = value;
  }
  return parsed;
}

function readEnvironmentFile(
  path: string,
  optional: boolean,
): { present: boolean; values: Record<string, string> } {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      optional &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { present: false, values: {} };
    }
    throw new WorkspaceEnvironmentError(
      optional
        ? "Repository .env exists but cannot be opened securely"
        : "Private environment file cannot be opened securely",
    );
  }
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new WorkspaceEnvironmentError(
        "Environment source must be a regular file",
      );
    }
    if (process.getuid && metadata.uid !== process.getuid()) {
      throw new WorkspaceEnvironmentError(
        "Environment source must be owned by the Pi Dash user",
      );
    }
    if ((metadata.mode & 0o022) !== 0) {
      throw new WorkspaceEnvironmentError(
        "Environment source cannot be writable by other users",
      );
    }
    if (metadata.size > MAX_ENVIRONMENT_BYTES) {
      throw new WorkspaceEnvironmentError(
        "Environment source exceeds the 1 MiB limit",
      );
    }
    const contents = readFileSync(descriptor, "utf8");
    const finalMetadata = fstatSync(descriptor);
    if (
      metadata.dev !== finalMetadata.dev ||
      metadata.ino !== finalMetadata.ino ||
      metadata.size !== finalMetadata.size ||
      metadata.mtimeMs !== finalMetadata.mtimeMs ||
      metadata.ctimeMs !== finalMetadata.ctimeMs
    ) {
      throw new WorkspaceEnvironmentError(
        "Environment source changed while it was being read",
      );
    }
    if (Buffer.byteLength(contents, "utf8") > MAX_ENVIRONMENT_BYTES) {
      throw new WorkspaceEnvironmentError(
        "Environment source exceeds the 1 MiB limit",
      );
    }
    return { present: true, values: parseDotenv(contents) };
  } finally {
    closeSync(descriptor);
  }
}

function fingerprint(values: Record<string, string>, error?: string): string {
  const hash = createHash("sha256");
  if (error) return hash.update(`error\0${error}`).digest("hex");
  for (const [name, value] of Object.entries(values).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(name).update("\0").update(value).update("\0");
  }
  return hash.digest("hex");
}

function sourceSignature(path: string): string {
  try {
    const metadata = lstatSync(path, { bigint: true });
    return [
      path,
      metadata.dev,
      metadata.ino,
      metadata.mode,
      metadata.size,
      metadata.mtimeNs,
      metadata.ctimeNs,
    ].join(":");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
    return `${path}:${code}`;
  }
}

function normalizePrivatePath(path: string): string {
  if (!isAbsolute(path)) {
    throw new WorkspaceEnvironmentError(
      "Private environment file path must be absolute",
    );
  }
  const normalized = resolve(path);
  if (normalized !== path) {
    throw new WorkspaceEnvironmentError(
      "Private environment file path must be normalized",
    );
  }
  return normalized;
}

export interface WorkspaceEnvironmentService {
  get(workspaceId: string): WorkspaceEnvironmentDto;
  updatePrivateFile(
    workspaceId: string,
    path: string | null,
  ): WorkspaceEnvironmentDto;
  prepareRuntime(input: {
    workspaceId: string;
    worktreeId: string;
    runtimeId: string;
    kind: RuntimeKind;
  }): Record<string, string>;
  runtimeChanged(workspaceId: string): void;
  changes(): WorkspaceEnvironmentChangeDto[];
  start(): void;
  close(): void;
}

export function createWorkspaceEnvironmentService(options: {
  repository: WorkspaceRepository;
  liveRuntimes: () => LiveWorkspaceRuntime[];
  onWorkspaceChanged?: (workspaceId: string) => void;
  inherited?: NodeJS.ProcessEnv;
  now?: () => Date;
  refreshIntervalMs?: number;
}): WorkspaceEnvironmentService {
  const now = options.now ?? (() => new Date());
  const refreshIntervalMs = options.refreshIntervalMs ?? 2_000;
  const states = new Map<string, EnvironmentState>();
  const applied = new Map<string, AppliedEnvironment>();
  let interval: NodeJS.Timeout | undefined;
  let lastChangesJson = "[]";

  const runtimeKey = (kind: RuntimeKind, worktreeId: string) =>
    `${kind}:${worktreeId}`;

  const requireRecord = (workspaceId: string): WorkspaceRecord => {
    const record = options.repository.get(workspaceId);
    if (!record) throw new WorkspaceEnvironmentError("Workspace was not found");
    return record;
  };

  const inspect = (record: WorkspaceRecord): EnvironmentState => {
    const repositoryPath = join(record.repositoryPath, ".env");
    const signature = [
      sourceSignature(repositoryPath),
      record.privateEnvironmentPath
        ? sourceSignature(record.privateEnvironmentPath)
        : "private:none",
    ].join("|");
    const cached = states.get(record.id);
    if (cached?.sourceSignature === signature) return cached;
    let repositoryPresent = false;
    try {
      const repository = readEnvironmentFile(repositoryPath, true);
      repositoryPresent = repository.present;
      const privateFile = record.privateEnvironmentPath
        ? readEnvironmentFile(record.privateEnvironmentPath, false)
        : { present: false, values: {} };
      const values = { ...repository.values, ...privateFile.values };
      if (Object.keys(values).length > MAX_VARIABLES) {
        throw new WorkspaceEnvironmentError(
          `Effective environment exceeds the ${MAX_VARIABLES} variable limit`,
        );
      }
      const environmentBytes = Object.entries(values).reduce(
        (total, [name, value]) =>
          total +
          Buffer.byteLength(name, "utf8") +
          Buffer.byteLength(value, "utf8") +
          2,
        0,
      );
      if (environmentBytes > MAX_EFFECTIVE_ENVIRONMENT_BYTES) {
        throw new WorkspaceEnvironmentError(
          "Effective environment exceeds the 256 KiB launch limit",
        );
      }
      return {
        dto: {
          workspaceId: record.id,
          repositoryFile: { path: repositoryPath, present: repositoryPresent },
          privateFilePath: record.privateEnvironmentPath,
          status: repository.present || privateFile.present ? "ready" : "empty",
          variableCount: Object.keys(values).length,
          error: null,
        },
        fingerprint: fingerprint(
          createBaseTerminalEnvironment(options.inherited ?? {}, values),
        ),
        sourceSignature: signature,
        values,
      };
    } catch (error) {
      const message =
        error instanceof WorkspaceEnvironmentError
          ? error.message
          : "Environment source could not be inspected";
      return {
        dto: {
          workspaceId: record.id,
          repositoryFile: { path: repositoryPath, present: repositoryPresent },
          privateFilePath: record.privateEnvironmentPath,
          status: "error",
          variableCount: 0,
          error: message,
        },
        fingerprint: fingerprint({}, message),
        sourceSignature: signature,
        values: {},
      };
    }
  };

  const computeChanges = (): WorkspaceEnvironmentChangeDto[] => {
    const byWorkspace = new Map<
      string,
      WorkspaceEnvironmentChangeDto["affectedRuntimes"]
    >();
    for (const { workspaceId, kind, runtime } of options.liveRuntimes()) {
      if (
        !runtime.runtimeId ||
        (runtime.state !== "starting" &&
          runtime.state !== "running" &&
          runtime.state !== "stopping")
      ) {
        continue;
      }
      const current = states.get(workspaceId);
      const runtimeEnvironment = applied.get(
        runtimeKey(kind, runtime.worktreeId),
      );
      if (
        !current ||
        !runtimeEnvironment ||
        runtimeEnvironment.runtimeId !== runtime.runtimeId ||
        runtimeEnvironment.fingerprint === current.fingerprint
      ) {
        continue;
      }
      const affected = byWorkspace.get(workspaceId) ?? [];
      affected.push({
        worktreeId: runtime.worktreeId,
        runtimeId: runtime.runtimeId,
        kind,
      });
      byWorkspace.set(workspaceId, affected);
    }
    return [...byWorkspace.entries()]
      .map(([workspaceId, affectedRuntimes]) => ({
        workspaceId,
        affectedRuntimes: affectedRuntimes.sort((left, right) =>
          `${left.worktreeId}:${left.kind}`.localeCompare(
            `${right.worktreeId}:${right.kind}`,
          ),
        ),
      }))
      .sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
  };

  const emitChanges = (workspaceId: string): void => {
    const encoded = JSON.stringify(computeChanges());
    if (encoded === lastChangesJson) return;
    lastChangesJson = encoded;
    try {
      options.onWorkspaceChanged?.(workspaceId);
    } catch {
      // Environment state and runtime ownership do not depend on event delivery.
    }
  };

  const installState = (
    workspaceId: string,
    state: EnvironmentState,
    publish: boolean,
  ): boolean => {
    const previous = states.get(workspaceId);
    states.set(workspaceId, state);
    const changed =
      !previous ||
      previous.fingerprint !== state.fingerprint ||
      JSON.stringify(previous.dto) !== JSON.stringify(state.dto);
    if (publish && changed) {
      try {
        options.onWorkspaceChanged?.(workspaceId);
      } catch {
        // File inspection remains independent from event delivery.
      }
      lastChangesJson = JSON.stringify(computeChanges());
    }
    return changed;
  };

  const refresh = (
    record: WorkspaceRecord,
    publish: boolean,
  ): EnvironmentState => {
    const state = inspect(record);
    installState(record.id, state, publish);
    return state;
  };

  const reconcileCache = (records: WorkspaceRecord[]): void => {
    const workspaceIds = new Set(records.map((record) => record.id));
    for (const workspaceId of states.keys()) {
      if (!workspaceIds.has(workspaceId)) states.delete(workspaceId);
    }
    const liveKeys = new Set(
      options
        .liveRuntimes()
        .filter(({ runtime }) => runtime.runtimeId !== null)
        .map(({ kind, runtime }) => runtimeKey(kind, runtime.worktreeId)),
    );
    for (const key of applied.keys()) {
      if (!liveKeys.has(key)) applied.delete(key);
    }
  };

  const service: WorkspaceEnvironmentService = {
    get(workspaceId) {
      return { ...refresh(requireRecord(workspaceId), true).dto };
    },
    updatePrivateFile(workspaceId, path) {
      const record = requireRecord(workspaceId);
      const normalized = path === null ? null : normalizePrivatePath(path);
      if (normalized) readEnvironmentFile(normalized, false);
      const updated = options.repository.updatePrivateEnvironmentPath(
        workspaceId,
        normalized,
        now().toISOString(),
      );
      const state = refresh(updated ?? record, false);
      try {
        options.onWorkspaceChanged?.(workspaceId);
      } catch {
        // Persisted configuration must not be undone by event delivery.
      }
      lastChangesJson = JSON.stringify(computeChanges());
      return { ...state.dto };
    },
    prepareRuntime(input) {
      const state = refresh(requireRecord(input.workspaceId), false);
      if (state.dto.status === "error") {
        throw new WorkspaceEnvironmentError(
          state.dto.error ?? "Workspace environment is invalid",
        );
      }
      applied.set(runtimeKey(input.kind, input.worktreeId), {
        workspaceId: input.workspaceId,
        runtimeId: input.runtimeId,
        fingerprint: state.fingerprint,
      });
      emitChanges(input.workspaceId);
      return { ...state.values };
    },
    runtimeChanged(workspaceId) {
      emitChanges(workspaceId);
    },
    changes() {
      return computeChanges();
    },
    start() {
      if (interval) return;
      const initialRecords = options.repository.list();
      for (const record of initialRecords) refresh(record, false);
      reconcileCache(initialRecords);
      lastChangesJson = JSON.stringify(computeChanges());
      interval = setInterval(() => {
        const records = options.repository.list();
        for (const record of records) refresh(record, true);
        reconcileCache(records);
      }, refreshIntervalMs);
      interval.unref();
    },
    close() {
      if (interval) clearInterval(interval);
      interval = undefined;
      states.clear();
      applied.clear();
    },
  };
  return service;
}
