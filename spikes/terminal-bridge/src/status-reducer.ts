import type { AttentionState, StatusEventFrame } from "./protocol.js";

export interface StatusSnapshot {
  state: AttentionState;
  agentActive: boolean;
  blockingInteractions: ReadonlySet<string>;
}

export function initialStatus(): StatusSnapshot {
  return { state: "idle", agentActive: false, blockingInteractions: new Set() };
}

export function reduceStatus(current: StatusSnapshot, frame: StatusEventFrame): StatusSnapshot {
  const blockingInteractions = new Set(current.blockingInteractions);
  let agentActive = current.agentActive;
  let state = current.state;

  switch (frame.event) {
    case "session_start":
      blockingInteractions.clear();
      agentActive = false;
      state = "idle";
      break;
    case "agent_start":
      blockingInteractions.clear();
      agentActive = true;
      state = "working";
      break;
    case "blocking_wait_start":
      if (!frame.interactionId) return current;
      blockingInteractions.add(frame.interactionId);
      state = "blocked";
      break;
    case "blocking_wait_end":
      if (!frame.interactionId || !blockingInteractions.has(frame.interactionId)) return current;
      blockingInteractions.delete(frame.interactionId);
      state = blockingInteractions.size > 0 ? "blocked" : agentActive ? "working" : "idle";
      break;
    case "agent_settled":
      blockingInteractions.clear();
      agentActive = false;
      state = "done";
      break;
    case "session_shutdown":
      blockingInteractions.clear();
      agentActive = false;
      state = "idle";
      break;
  }

  return { state, agentActive, blockingInteractions };
}
