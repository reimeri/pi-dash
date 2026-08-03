import {
  APPLICATION_EVENTS_PROTOCOL_VERSION,
  ApplicationEventsServerFrameSchema,
  type ApplicationEventsServerFrame,
  type WorkspaceDto,
} from "@pi-dash/contracts";
import { Value } from "@sinclair/typebox/value";
import { workflowStatusStore } from "./store.js";

export interface StatusEventClient {
  start(): void;
  close(): void;
}

export function createStatusEventClient(
  options: {
    url?: () => string;
    createSocket?: (url: string) => WebSocket;
    reconnectBaseMs?: number;
    onWorktreeRemoved?: (workspaceId: string, worktreeId: string) => void;
    onWorkspaceUpdated?: (workspace: WorkspaceDto) => void;
    onWorkspaceOrderUpdated?: (workspaceIds: string[]) => void;
    onSnapshot?: () => void;
  } = {},
): StatusEventClient {
  const url =
    options.url ??
    (() => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      return `${scheme}://${location.host}/api/v1/events/socket`;
    });
  const createSocket =
    options.createSocket ?? ((target) => new WebSocket(target));
  const reconnectBaseMs = options.reconnectBaseMs ?? 500;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let closed = false;

  function connect(): void {
    if (closed || socket) return;
    workflowStatusStore.setChannel("connecting");
    const candidate = createSocket(url());
    socket = candidate;
    candidate.addEventListener("open", () => {
      if (socket !== candidate) return;
      attempts = 0;
      candidate.send(
        JSON.stringify({
          v: APPLICATION_EVENTS_PROTOCOL_VERSION,
          type: "subscribe",
          afterCursor: workflowStatusStore.current().cursor,
        }),
      );
    });
    candidate.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        candidate.close(1007, "Malformed application event");
        return;
      }
      if (!Value.Check(ApplicationEventsServerFrameSchema, parsed)) {
        candidate.close(1008, "Invalid application event");
        return;
      }
      const frame = parsed as ApplicationEventsServerFrame;
      if (!workflowStatusStore.apply(frame)) {
        candidate.close(1012, "Status resynchronization required");
        return;
      }
      if (frame.type === "worktreeRemoved") {
        options.onWorktreeRemoved?.(frame.workspaceId, frame.worktreeId);
      } else if (frame.type === "workspaceUpdated") {
        options.onWorkspaceUpdated?.(frame.workspace);
      } else if (frame.type === "workspaceOrderUpdated") {
        options.onWorkspaceOrderUpdated?.(frame.workspaceIds);
      } else if (frame.type === "snapshot") {
        options.onSnapshot?.();
      }
    });
    candidate.addEventListener("close", () => {
      if (socket !== candidate) return;
      socket = undefined;
      workflowStatusStore.setChannel("disconnected");
      if (closed || reconnectTimer) return;
      const delay = Math.min(10_000, reconnectBaseMs * 2 ** attempts);
      attempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    });
    candidate.addEventListener("error", () => {
      workflowStatusStore.setChannel("disconnected");
    });
  }

  return {
    start() {
      closed = false;
      connect();
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      socket?.close(1000, "Status event client closed");
      socket = undefined;
      workflowStatusStore.setChannel("disconnected");
    },
  };
}
