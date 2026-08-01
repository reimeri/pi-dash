import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createConnection, type Socket } from "node:net";

const socketPath = process.env.PI_DASH_STATUS_SOCKET;
const runtimeId = process.env.PI_DASH_RUNTIME_ID;
const token = process.env.PI_DASH_STATUS_TOKEN;

type EventName =
  | "session_start"
  | "agent_start"
  | "blocking_wait_start"
  | "blocking_wait_end"
  | "agent_settled"
  | "session_shutdown";

interface AttentionEvent {
  phase?: "start" | "end";
  interactionId?: string;
  reason?: string;
}

export default function statusExtension(pi: ExtensionAPI) {
  let socket: Socket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let agentActive = false;
  let settled = false;
  const blocking = new Map<string, string | undefined>();

  const configured = Boolean(socketPath && runtimeId && token);

  function frame(event: EventName, interactionId?: string, reason?: string): string {
    return `${JSON.stringify({ v: 0, runtimeId, token, event, interactionId, reason })}\n`;
  }

  function write(event: EventName, interactionId?: string, reason?: string): void {
    if (socket?.writable) socket.write(frame(event, interactionId, reason));
  }

  function sendSnapshot(): void {
    write("session_start");
    if (agentActive) write("agent_start");
    for (const [interactionId, reason] of blocking) write("blocking_wait_start", interactionId, reason);
    if (settled) write("agent_settled");
  }

  function scheduleReconnect(): void {
    if (!active || retryTimer || !configured) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, 500);
    retryTimer.unref?.();
  }

  function connect(): void {
    if (!active || !configured || socket) return;
    const candidate = createConnection(socketPath!);
    socket = candidate;
    candidate.setNoDelay(true);
    candidate.once("connect", sendSnapshot);
    candidate.once("error", () => undefined);
    candidate.once("close", () => {
      if (socket === candidate) socket = undefined;
      scheduleReconnect();
    });
  }

  function stop(): void {
    active = false;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    const current = socket;
    socket = undefined;
    current?.end();
    current?.destroySoon();
  }

  pi.on("session_start", () => {
    active = true;
    agentActive = false;
    settled = false;
    blocking.clear();
    connect();
  });

  pi.on("agent_start", () => {
    agentActive = true;
    settled = false;
    blocking.clear();
    write("agent_start");
  });

  pi.events.on("pi-dash:attention", (value) => {
    if (!active || typeof value !== "object" || value === null) return;
    const event = value as AttentionEvent;
    if ((event.phase !== "start" && event.phase !== "end") || !event.interactionId) return;
    if (event.phase === "start") {
      settled = false;
      blocking.set(event.interactionId, event.reason);
      write("blocking_wait_start", event.interactionId, event.reason);
    } else {
      blocking.delete(event.interactionId);
      write("blocking_wait_end", event.interactionId, event.reason);
    }
  });

  pi.on("agent_settled", () => {
    agentActive = false;
    settled = true;
    blocking.clear();
    write("agent_settled");
  });

  pi.on("session_shutdown", () => {
    write("session_shutdown");
    stop();
  });
}
