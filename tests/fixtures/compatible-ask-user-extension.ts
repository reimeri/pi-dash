import { randomUUID } from "node:crypto";

export interface AttentionEventBus {
  emit(
    event: "pi-dash:attention",
    payload: {
      phase: "start" | "end";
      interactionId: string;
      reason: "ask_user";
    },
  ): void;
}

/**
 * Reference integration boundary for an interactive ask-user extension.
 * Call this only after tool preflight, immediately around the actual UI await.
 */
export async function awaitCompatibleAskUser<T>(
  events: AttentionEventBus,
  awaitTerminalUi: () => Promise<T>,
): Promise<T> {
  const interactionId = randomUUID();
  events.emit("pi-dash:attention", {
    phase: "start",
    interactionId,
    reason: "ask_user",
  });
  try {
    return await awaitTerminalUi();
  } finally {
    events.emit("pi-dash:attention", {
      phase: "end",
      interactionId,
      reason: "ask_user",
    });
  }
}
