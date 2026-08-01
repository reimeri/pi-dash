export const PI_DASH_ATTENTION_EVENT = "pi-dash:attention" as const;
export const PI_DASH_ATTENTION_REASON = "ask_user" as const;

export interface PiDashAttentionEvent {
  phase: "start" | "end";
  interactionId: string;
  reason: typeof PI_DASH_ATTENTION_REASON;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAttentionEvent(
  value: unknown,
): PiDashAttentionEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (
    (event.phase !== "start" && event.phase !== "end") ||
    event.reason !== PI_DASH_ATTENTION_REASON ||
    typeof event.interactionId !== "string" ||
    !UUID_PATTERN.test(event.interactionId)
  ) {
    return undefined;
  }
  return {
    phase: event.phase,
    interactionId: event.interactionId,
    reason: PI_DASH_ATTENTION_REASON,
  };
}
