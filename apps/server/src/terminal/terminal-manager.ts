import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type {
  ApiErrorCode,
  RestartRuntimeResponse,
  RuntimeDto,
} from "@pi-dash/contracts";
import type { PiResolver } from "../pi/pi-resolver.js";
import { PiResolutionError } from "../pi/pi-resolver.js";
import type { WorktreeLifecycleCoordinator } from "../worktrees/worktree-lifecycle.js";
import { WorktreeServiceError } from "../worktrees/worktree-service.js";
import type { TerminalSocketTransport } from "./terminal-runtime.js";
import { TerminalRuntime } from "./terminal-runtime.js";

export class TerminalManagerError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TerminalManagerError";
  }
}

interface RestartOperation {
  hash: string;
  promise: Promise<RestartRuntimeResponse>;
}

export interface TerminalManagerOptions {
  lifecycle: WorktreeLifecycleCoordinator;
  pi: PiResolver;
  getWorktree(id: string): { id: string };
  verifyWorktree(id: string): Promise<{ id: string }>;
  inheritedEnv: NodeJS.ProcessEnv;
  runtimeDirectory: string;
  initialCols: number;
  initialRows: number;
  outputBufferBytes: number;
  maxSocketBufferedBytes: number;
  stopGraceMs: number;
  now?: () => Date;
  id?: () => string;
}

function stoppedRuntime(worktreeId: string): RuntimeDto {
  return {
    worktreeId,
    runtimeId: null,
    state: "stopped",
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    signal: null,
    attachedClients: 0,
  };
}

export function createTerminalManager(options: TerminalManagerOptions) {
  const now = options.now ?? (() => new Date());
  const createId = options.id ?? randomUUID;
  const runtimes = new Map<string, TerminalRuntime>();
  const locks = new Map<string, Promise<void>>();
  const restartOperations = new Map<string, RestartOperation>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  async function exclusive<T>(
    worktreeId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(worktreeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    locks.set(worktreeId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(worktreeId) === queued) locks.delete(worktreeId);
    }
  }

  function runtimeDto(worktreeId: string): RuntimeDto {
    return { ...(runtimes.get(worktreeId)?.dto ?? stoppedRuntime(worktreeId)) };
  }

  async function startLocked(worktreeId: string): Promise<RuntimeDto> {
    if (shuttingDown) {
      throw new TerminalManagerError(
        503,
        "RUNTIME_STOPPING",
        "The terminal manager is shutting down",
      );
    }
    options.getWorktree(worktreeId);
    if (!options.lifecycle.canStartTerminal(worktreeId)) {
      throw new TerminalManagerError(
        409,
        "WORKTREE_NOT_READY",
        "The managed worktree is not ready for a terminal runtime",
      );
    }
    const existing = runtimes.get(worktreeId);
    if (
      existing?.dto.state === "running" ||
      existing?.dto.state === "starting"
    ) {
      return { ...existing.dto };
    }
    if (existing) {
      try {
        await existing.stop();
      } catch {
        throw new TerminalManagerError(
          503,
          "RUNTIME_STOPPING",
          "The prior terminal process tree could not be stopped safely",
        );
      }
    }

    const claimed = options.lifecycle.claimTerminalStart(worktreeId);
    if (!claimed) {
      throw new TerminalManagerError(
        409,
        "WORKTREE_NOT_READY",
        "The managed worktree is not ready for a terminal runtime",
      );
    }

    let runtime: TerminalRuntime;
    try {
      if (claimed.health !== "healthy") {
        throw new TerminalManagerError(
          409,
          "WORKTREE_UNHEALTHY",
          "The managed worktree must be healthy before Pi can start",
        );
      }
      runtime = new TerminalRuntime({
        worktreeId,
        runtimeId: createId(),
        cwd: claimed.path,
        inheritedEnv: options.inheritedEnv,
        runtimeDirectory: options.runtimeDirectory,
        initialCols: options.initialCols,
        initialRows: options.initialRows,
        outputBufferBytes: options.outputBufferBytes,
        maxSocketBufferedBytes: options.maxSocketBufferedBytes,
        stopGraceMs: options.stopGraceMs,
        now,
      });
      existing?.dispose();
      runtimes.set(worktreeId, runtime);
    } finally {
      options.lifecycle.releaseTerminalStart(worktreeId);
    }

    try {
      const [canonicalPath, metadata, pi] = await Promise.all([
        realpath(claimed.path),
        stat(claimed.path),
        options.pi.probe(),
        options.verifyWorktree(worktreeId),
      ]);
      if (canonicalPath !== claimed.path || !metadata.isDirectory()) {
        throw new TerminalManagerError(
          409,
          "WORKTREE_UNHEALTHY",
          "The managed worktree path is no longer an exact directory",
        );
      }
      await runtime.start(pi);
      return { ...runtime.dto };
    } catch (error) {
      try {
        await runtime.stop();
      } catch {
        // Preserve the original sanitized startup failure.
      }
      runtime.failStart();
      if (error instanceof TerminalManagerError) throw error;
      if (error instanceof PiResolutionError) {
        throw new TerminalManagerError(503, error.code, error.message);
      }
      if (error instanceof WorktreeServiceError) {
        throw new TerminalManagerError(
          error.statusCode,
          error.code,
          error.message,
        );
      }
      throw new TerminalManagerError(
        503,
        "PTY_START_FAILED",
        "Pi could not be started in the managed worktree",
      );
    }
  }

  async function stopLocked(worktreeId: string): Promise<RuntimeDto> {
    options.getWorktree(worktreeId);
    const runtime = runtimes.get(worktreeId);
    if (!runtime) return stoppedRuntime(worktreeId);
    try {
      await runtime.stop();
    } catch {
      throw new TerminalManagerError(
        503,
        "RUNTIME_STOPPING",
        "The owned terminal process tree could not be stopped safely",
      );
    }
    return { ...runtime.dto };
  }

  return {
    get(worktreeId: string): RuntimeDto {
      options.getWorktree(worktreeId);
      return runtimeDto(worktreeId);
    },

    start(worktreeId: string): Promise<RuntimeDto> {
      return exclusive(worktreeId, () => startLocked(worktreeId));
    },

    stop(worktreeId: string): Promise<RuntimeDto> {
      return exclusive(worktreeId, () => stopLocked(worktreeId));
    },

    restart(
      worktreeId: string,
      idempotencyKey: string,
    ): Promise<RestartRuntimeResponse> {
      const hash = createHash("sha256")
        .update(JSON.stringify({ operation: "terminal-restart", worktreeId }))
        .digest("hex");
      const prior = restartOperations.get(idempotencyKey);
      if (prior) {
        if (prior.hash !== hash) {
          throw new TerminalManagerError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key was already used with different input",
          );
        }
        return prior.promise;
      }
      if (restartOperations.size >= 1_024) {
        throw new TerminalManagerError(
          503,
          "OPERATION_IN_PROGRESS",
          "Terminal restart retry capacity is exhausted for this daemon lifetime",
        );
      }
      const operationId = createId();
      const promise = exclusive(worktreeId, async () => {
        await stopLocked(worktreeId);
        const runtime = await startLocked(worktreeId);
        return { operationId, runtime };
      });
      restartOperations.set(idempotencyKey, { hash, promise });
      return promise;
    },

    attach(
      worktreeId: string,
      connectionId: string,
      afterSeq: number,
      socket: TerminalSocketTransport,
    ): () => void {
      options.getWorktree(worktreeId);
      const runtime = runtimes.get(worktreeId);
      if (!runtime) {
        throw new TerminalManagerError(
          409,
          "WORKTREE_NOT_READY",
          "Start the terminal runtime before attaching",
        );
      }
      return runtime.attach(connectionId, afterSeq, socket);
    },

    input(
      worktreeId: string,
      connectionId: string,
      data: string | Buffer,
    ): void {
      const runtime = runtimes.get(worktreeId);
      if (!runtime?.input(connectionId, data)) {
        throw new TerminalManagerError(
          409,
          "NOT_INPUT_OWNER",
          "This connection does not own terminal input",
        );
      }
    },

    resize(
      worktreeId: string,
      connectionId: string,
      cols: number,
      rows: number,
    ): void {
      const runtime = runtimes.get(worktreeId);
      if (!runtime?.resize(connectionId, cols, rows)) {
        throw new TerminalManagerError(
          409,
          "NOT_INPUT_OWNER",
          "This connection does not own terminal resize",
        );
      }
    },

    async dispose(worktreeId: string): Promise<void> {
      await exclusive(worktreeId, async () => {
        const runtime = runtimes.get(worktreeId);
        if (!runtime) return;
        await stopLocked(worktreeId);
        runtime.dispose();
        runtimes.delete(worktreeId);
      });
    },

    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        shuttingDown = true;
        const worktreeIds = [...runtimes.keys()];
        const results = await Promise.allSettled(
          worktreeIds.map((worktreeId) =>
            exclusive(worktreeId, () => stopLocked(worktreeId)),
          ),
        );
        const failures: unknown[] = [];
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]!;
          const worktreeId = worktreeIds[index]!;
          if (result.status === "rejected") {
            failures.push(result.reason);
            continue;
          }
          runtimes.get(worktreeId)?.dispose();
          runtimes.delete(worktreeId);
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "One or more terminal process trees could not be stopped",
          );
        }
      })();
      return shutdownPromise;
    },

    diagnostics() {
      return {
        runtimes: runtimes.size,
        attachedClients: [...runtimes.values()].reduce(
          (total, runtime) => total + runtime.dto.attachedClients,
          0,
        ),
        bufferedBytes: [...runtimes.values()].reduce(
          (total, runtime) => total + runtime.output.bytes,
          0,
        ),
      };
    },
  };
}

export type TerminalManager = ReturnType<typeof createTerminalManager>;
