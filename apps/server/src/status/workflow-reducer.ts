import type {
  StatusExtensionFrame,
  WorkflowReason,
  WorkflowState,
} from "@pi-dash/contracts";

export interface WorkflowTransientState {
  agentActive: boolean;
  blockingInteractions: Map<string, "ask_user">;
}

export interface WorkflowReduction {
  transient: WorkflowTransientState;
  transition?: { state: WorkflowState; reason: WorkflowReason };
}

export function emptyTransientState(): WorkflowTransientState {
  return { agentActive: false, blockingInteractions: new Map() };
}

function derivedTransition(
  current: WorkflowState,
  transient: WorkflowTransientState,
): WorkflowReduction["transition"] {
  if (transient.blockingInteractions.size > 0) {
    return { state: "blocked", reason: "ask_user" };
  }
  if (transient.agentActive) return { state: "working", reason: "agent" };
  if (current === "done") return undefined;
  return { state: "idle", reason: null };
}

export function reduceWorkflowFrame(
  current: WorkflowState,
  transient: WorkflowTransientState,
  frame: StatusExtensionFrame,
): WorkflowReduction {
  if (frame.kind === "snapshot") {
    const next = {
      agentActive: frame.agentActive,
      blockingInteractions: new Map(
        frame.blockingInteractions.map((interaction) => [
          interaction.id,
          interaction.reason,
        ]),
      ),
    } satisfies WorkflowTransientState;
    return { transient: next, transition: derivedTransition(current, next) };
  }

  switch (frame.event) {
    case "session_start": {
      const next = emptyTransientState();
      return { transient: next };
    }
    case "session_shutdown":
      return { transient };
    case "agent_start": {
      const next = emptyTransientState();
      next.agentActive = true;
      return {
        transient: next,
        transition: { state: "working", reason: "agent" },
      };
    }
    case "blocking_wait_start": {
      if (!transient.agentActive) return { transient };
      const next = {
        agentActive: true,
        blockingInteractions: new Map(transient.blockingInteractions),
      };
      next.blockingInteractions.set(frame.interactionId, "ask_user");
      return {
        transient: next,
        transition: { state: "blocked", reason: "ask_user" },
      };
    }
    case "blocking_wait_end": {
      if (!transient.blockingInteractions.has(frame.interactionId)) {
        return { transient };
      }
      const next = {
        agentActive: transient.agentActive,
        blockingInteractions: new Map(transient.blockingInteractions),
      };
      next.blockingInteractions.delete(frame.interactionId);
      return { transient: next, transition: derivedTransition(current, next) };
    }
    case "agent_settled":
      return {
        transient: emptyTransientState(),
        transition: { state: "done", reason: "settled" },
      };
  }
}
