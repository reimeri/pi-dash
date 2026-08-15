import {
  APPLICATION_EVENTS_PROTOCOL_VERSION,
  ApplicationEventsServerFrameSchema,
  type ApplicationEventsServerFrame,
  type WorkspaceDto,
} from "@pi-dash/contracts";
import { Value } from "@sinclair/typebox/value";
import {
  CLIENT_PROTOCOL_ERROR_CLOSE_CODE,
  CLIENT_RECONNECT_CLOSE_CODE,
} from "../websocket-close-codes.js";
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
    onWorkspaceEnvironmentChanged?: (workspaceId: string) => void;
    onSnapshot?: () => void;
    onAuthenticationRequired?: () => void;
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
      if (socket !== candidate) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        candidate.close(
          CLIENT_PROTOCOL_ERROR_CLOSE_CODE,
          "Malformed application event",
        );
        return;
      }
      if (!Value.Check(ApplicationEventsServerFrameSchema, parsed)) {
        candidate.close(
          CLIENT_PROTOCOL_ERROR_CLOSE_CODE,
          "Invalid application event",
        );
        return;
      }
      const frame = parsed as ApplicationEventsServerFrame;
      if (!workflowStatusStore.apply(frame)) {
        candidate.close(
          CLIENT_RECONNECT_CLOSE_CODE,
          "Status resynchronization required",
        );
        return;
      }
      if (frame.type === "worktreeRemoved") {
        options.onWorktreeRemoved?.(frame.workspaceId, frame.worktreeId);
      } else if (frame.type === "workspaceUpdated") {
        options.onWorkspaceUpdated?.(frame.workspace);
      } else if (frame.type === "workspaceOrderUpdated") {
        options.onWorkspaceOrderUpdated?.(frame.workspaceIds);
      } else if (frame.type === "workspaceEnvironmentChanged") {
        options.onWorkspaceEnvironmentChanged?.(frame.workspaceId);
      } else if (frame.type === "snapshot") {
        options.onSnapshot?.();
      }
    });
    candidate.addEventListener("close", (event) => {
      if (socket !== candidate) return;
      socket = undefined;
      workflowStatusStore.setChannel("disconnected");
      if (closed || reconnectTimer) return;
      if (event.code === 4001 && options.onAuthenticationRequired) {
        options.onAuthenticationRequired();
        return;
      }
      const delay = Math.min(10_000, reconnectBaseMs * 2 ** attempts);
      attempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    });
    candidate.addEventListener("error", () => {
      if (socket !== candidate) return;
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
