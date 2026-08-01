import { timingSafeEqual } from "node:crypto";
import type {
  StatusExtensionFrame,
  StatusIntegration,
  WorkflowStatusDto,
  WorkspaceAttentionDto,
} from "@pi-dash/contracts";
import type { StatusRepository } from "./status-repository.js";
import {
  emptyTransientState,
  reduceWorkflowFrame,
  type WorkflowTransientState,
} from "./workflow-reducer.js";

export type StatusProcessingErrorCode =
  "STATUS_RUNTIME_UNKNOWN" | "STATUS_AUTH_FAILED" | "STATUS_EVENT_INVALID";

export class StatusProcessingError extends Error {
  constructor(readonly code: StatusProcessingErrorCode) {
    super(code);
    this.name = "StatusProcessingError";
  }
}

interface RuntimeRegistration {
  runtimeId: string;
  worktreeId: string;
  token: Buffer;
  extensionInstanceId?: string;
  retiredEpochs: Set<string>;
  lastSeq: number;
  transient: WorkflowTransientState;
  lastCompletionId?: string;
  acknowledgedCompletionId?: string;
  handshakeTimer?: ReturnType<typeof setTimeout>;
}

export interface StatusService {
  list(): WorkflowStatusDto[];
  get(worktreeId: string): WorkflowStatusDto | undefined;
  workspaceAttention(): WorkspaceAttentionDto[];
  registerRuntime(worktreeId: string, runtimeId: string, token: string): void;
  resetRuntime(worktreeId: string, runtimeId: string): void;
  process(frame: StatusExtensionFrame): WorkflowStatusDto;
  disconnect(runtimeId: string, extensionInstanceId: string): void;
  markUnsupported(worktreeId: string): void;
  acknowledge(worktreeId: string, revision: number): WorkflowStatusDto;
  setPublisher(publish: (status: WorkflowStatusDto) => void): void;
}

const MAX_RETIRED_EPOCHS = 64;

const ATTENTION_PRIORITY = {
  idle: 0,
  working: 1,
  done: 2,
  blocked: 3,
} as const;

function tokenMatches(expected: Buffer, received: string): boolean {
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createStatusService(options: {
  repository: StatusRepository;
  now?: () => Date;
  handshakeTimeoutMs?: number;
}): StatusService {
  const now = options.now ?? (() => new Date());
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  const runtimesById = new Map<string, RuntimeRegistration>();
  const runtimeByWorktree = new Map<string, string>();
  let publish: (status: WorkflowStatusDto) => void = () => undefined;

  function emitIfChanged(
    previous: WorkflowStatusDto | undefined,
    current: WorkflowStatusDto | undefined,
  ): WorkflowStatusDto {
    if (!current) throw new StatusProcessingError("STATUS_RUNTIME_UNKNOWN");
    if (
      !previous ||
      previous.revision !== current.revision ||
      previous.integration !== current.integration
    ) {
      publish(current);
    }
    return current;
  }

  function setIntegration(
    worktreeId: string,
    integration: StatusIntegration,
  ): WorkflowStatusDto {
    const previous = options.repository.get(worktreeId);
    const current = options.repository.setIntegration(worktreeId, integration);
    return emitIfChanged(previous, current);
  }

  function transition(
    worktreeId: string,
    state: WorkflowStatusDto["state"],
    reason: WorkflowStatusDto["reason"],
  ): WorkflowStatusDto {
    const previous = options.repository.get(worktreeId);
    const current = options.repository.transition(
      worktreeId,
      state,
      reason,
      now().toISOString(),
    );
    return emitIfChanged(previous, current);
  }

  return {
    list: () => options.repository.list(),
    get: (worktreeId) => options.repository.get(worktreeId),
    workspaceAttention() {
      const aggregates = new Map<string, WorkspaceAttentionDto>();
      for (const {
        workspaceId,
        status,
      } of options.repository.listWithWorkspaces()) {
        const current = aggregates.get(workspaceId) ?? {
          workspaceId,
          state: "idle" as const,
          count: 0,
        };
        if (status.state !== "idle") current.count += 1;
        if (
          ATTENTION_PRIORITY[status.state] > ATTENTION_PRIORITY[current.state]
        ) {
          current.state = status.state;
        }
        aggregates.set(workspaceId, current);
      }
      return [...aggregates.values()];
    },
    registerRuntime(worktreeId, runtimeId, token) {
      const priorRuntimeId = runtimeByWorktree.get(worktreeId);
      if (priorRuntimeId && priorRuntimeId !== runtimeId) {
        const prior = runtimesById.get(priorRuntimeId);
        if (prior?.handshakeTimer) clearTimeout(prior.handshakeTimer);
        runtimesById.delete(priorRuntimeId);
      }
      const runtime: RuntimeRegistration = {
        runtimeId,
        worktreeId,
        token: Buffer.from(token),
        retiredEpochs: new Set(),
        lastSeq: 0,
        transient: emptyTransientState(),
      };
      runtime.handshakeTimer = setTimeout(() => {
        if (
          runtimesById.get(runtimeId) === runtime &&
          !runtime.extensionInstanceId
        ) {
          try {
            setIntegration(worktreeId, "unsupported");
          } catch {
            // Compatibility diagnostics are fail-open.
          }
        }
      }, handshakeTimeoutMs);
      runtime.handshakeTimer.unref?.();
      runtimesById.set(runtimeId, runtime);
      runtimeByWorktree.set(worktreeId, runtimeId);
      setIntegration(worktreeId, "disconnected");
    },
    resetRuntime(worktreeId, runtimeId) {
      if (runtimeByWorktree.get(worktreeId) !== runtimeId) return;
      runtimeByWorktree.delete(worktreeId);
      const runtime = runtimesById.get(runtimeId);
      if (runtime?.handshakeTimer) clearTimeout(runtime.handshakeTimer);
      runtimesById.delete(runtimeId);
      const current = options.repository.get(worktreeId);
      if (!current) return;
      if (current.state === "working" || current.state === "blocked") {
        transition(worktreeId, "idle", "runtime_reset");
      }
      setIntegration(worktreeId, "disconnected");
    },
    process(frame) {
      const runtime = runtimesById.get(frame.runtimeId);
      if (!runtime || runtime.worktreeId !== frame.worktreeId) {
        throw new StatusProcessingError("STATUS_RUNTIME_UNKNOWN");
      }
      if (!tokenMatches(runtime.token, frame.token)) {
        throw new StatusProcessingError("STATUS_AUTH_FAILED");
      }

      const isHandshake =
        frame.kind === "event" && frame.event === "session_start";
      if (isHandshake) {
        if (runtime.retiredEpochs.has(frame.extensionInstanceId)) {
          throw new StatusProcessingError("STATUS_EVENT_INVALID");
        }
        if (runtime.extensionInstanceId !== frame.extensionInstanceId) {
          if (runtime.extensionInstanceId) {
            if (runtime.retiredEpochs.size >= MAX_RETIRED_EPOCHS) {
              throw new StatusProcessingError("STATUS_EVENT_INVALID");
            }
            runtime.retiredEpochs.add(runtime.extensionInstanceId);
          }
          runtime.extensionInstanceId = frame.extensionInstanceId;
          runtime.lastSeq = 0;
          runtime.transient = emptyTransientState();
        }
      } else if (runtime.extensionInstanceId !== frame.extensionInstanceId) {
        throw new StatusProcessingError("STATUS_EVENT_INVALID");
      }
      if (frame.seq <= runtime.lastSeq) {
        throw new StatusProcessingError("STATUS_EVENT_INVALID");
      }
      runtime.lastSeq = frame.seq;
      if (isHandshake && runtime.handshakeTimer) {
        clearTimeout(runtime.handshakeTimer);
        runtime.handshakeTimer = undefined;
      }

      if (frame.kind === "snapshot") {
        const interactionIds = new Set(
          frame.blockingInteractions.map((interaction) => interaction.id),
        );
        if (
          (!frame.agentActive && frame.blockingInteractions.length > 0) ||
          interactionIds.size !== frame.blockingInteractions.length
        ) {
          throw new StatusProcessingError("STATUS_EVENT_INVALID");
        }
      }
      const current = options.repository.get(frame.worktreeId);
      if (!current) throw new StatusProcessingError("STATUS_RUNTIME_UNKNOWN");
      if (frame.kind === "event" && frame.event === "agent_settled") {
        runtime.lastCompletionId = frame.completionId;
        if (runtime.acknowledgedCompletionId === frame.completionId) {
          return current;
        }
      }
      const reduction = reduceWorkflowFrame(
        current.state,
        runtime.transient,
        frame,
      );
      runtime.transient = reduction.transient;
      let result = current;
      if (reduction.transition) {
        result = transition(
          frame.worktreeId,
          reduction.transition.state,
          reduction.transition.reason,
        );
      }
      if (isHandshake) result = setIntegration(frame.worktreeId, "connected");
      if (frame.kind === "event" && frame.event === "session_shutdown") {
        result = setIntegration(frame.worktreeId, "disconnected");
      }
      return result;
    },
    disconnect(runtimeId, extensionInstanceId) {
      const runtime = runtimesById.get(runtimeId);
      if (runtime?.extensionInstanceId !== extensionInstanceId) return;
      setIntegration(runtime.worktreeId, "disconnected");
    },
    markUnsupported(worktreeId) {
      setIntegration(worktreeId, "unsupported");
    },
    acknowledge(worktreeId, revision) {
      const current = options.repository.get(worktreeId);
      if (!current) throw new StatusProcessingError("STATUS_RUNTIME_UNKNOWN");
      if (current.state !== "done" || current.revision !== revision) {
        throw new StatusProcessingError("STATUS_EVENT_INVALID");
      }
      const acknowledged = options.repository.acknowledge(
        worktreeId,
        revision,
        now().toISOString(),
      );
      const runtimeId = runtimeByWorktree.get(worktreeId);
      const runtime = runtimeId ? runtimesById.get(runtimeId) : undefined;
      if (runtime?.lastCompletionId) {
        runtime.acknowledgedCompletionId = runtime.lastCompletionId;
      }
      return emitIfChanged(current, acknowledged);
    },
    setPublisher(next) {
      publish = next;
    },
  };
}
