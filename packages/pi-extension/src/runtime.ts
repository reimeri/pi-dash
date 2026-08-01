import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  parseAttentionEvent,
  PI_DASH_ATTENTION_EVENT,
  type PiDashAttentionEvent,
} from "./attention.js";

interface ExtensionApiLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  events: {
    on(event: string, handler: (data: unknown) => void): unknown;
    off?(event: string, handler: (data: unknown) => void): void;
  };
}

interface StatusConfiguration {
  socketPath: string;
  runtimeId: string;
  worktreeId: string;
  token: string;
}

type StatusEventName =
  | "agent_start"
  | "agent_settled"
  | "session_shutdown"
  | "blocking_wait_start"
  | "blocking_wait_end";

interface QueuedEvent {
  event: StatusEventName;
  interactionId?: string;
  reason?: "ask_user";
  completionId?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QUEUED_EVENTS = 128;
const RECONNECT_DELAY_MS = 500;

function readConfiguration(): StatusConfiguration | undefined {
  const socketPath = process.env.PI_DASH_STATUS_SOCKET;
  const runtimeId = process.env.PI_DASH_RUNTIME_ID;
  const worktreeId = process.env.PI_DASH_WORKTREE_ID;
  const token = process.env.PI_DASH_STATUS_TOKEN;
  if (
    !socketPath ||
    socketPath.length > 4_096 ||
    !runtimeId ||
    !UUID_PATTERN.test(runtimeId) ||
    !worktreeId ||
    !UUID_PATTERN.test(worktreeId) ||
    !token ||
    token.length < 32 ||
    token.length > 512
  ) {
    return undefined;
  }
  return { socketPath, runtimeId, worktreeId, token };
}

class FailOpenStatusClient {
  #socket?: Socket;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #queue: QueuedEvent[] = [];
  #seq = 0;
  #started = false;
  #ready = false;
  #closed = false;

  constructor(
    private readonly config: StatusConfiguration,
    private readonly extensionInstanceId: string,
    private readonly snapshot: () => {
      agentActive: boolean;
      settledCompletionId?: string;
      blockingInteractions: Array<{ id: string; reason: "ask_user" }>;
    },
  ) {}

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#connect();
  }

  report(event: QueuedEvent): void {
    if (this.#closed) return;
    if (this.#queue.length >= MAX_QUEUED_EVENTS) this.#queue.shift();
    this.#queue.push(event);
    if (this.#ready) this.#flush();
  }

  shutdown(): void {
    if (this.#closed) return;
    this.report({ event: "session_shutdown" });
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    try {
      this.#socket?.end();
    } catch {
      this.#socket?.destroy();
    }
    this.#socket = undefined;
    this.#ready = false;
    this.#queue = [];
  }

  #base() {
    return {
      v: 1 as const,
      runtimeId: this.config.runtimeId,
      worktreeId: this.config.worktreeId,
      token: this.config.token,
      extensionInstanceId: this.extensionInstanceId,
      timestamp: new Date().toISOString(),
    };
  }

  #write(payload: object): boolean {
    if (!this.#socket || !this.#socket.writable) return false;
    try {
      this.#seq += 1;
      this.#socket.write(
        `${JSON.stringify({ ...this.#base(), seq: this.#seq, ...payload })}\n`,
      );
      return true;
    } catch {
      return false;
    }
  }

  #connect(): void {
    if (this.#closed || this.#socket) return;
    let socket: Socket;
    try {
      socket = createConnection(this.config.socketPath);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.unref();
    socket.setNoDelay(true);
    socket.once("connect", () => {
      if (this.#closed || this.#socket !== socket) return;
      if (!this.#write({ kind: "event", event: "session_start" })) return;
      const { settledCompletionId, ...snapshot } = this.snapshot();
      this.#queue = [];
      if (!this.#write({ kind: "snapshot", ...snapshot })) return;
      this.#ready = true;
      if (settledCompletionId) {
        this.report({
          event: "agent_settled",
          completionId: settledCompletionId,
        });
      }
    });
    socket.on("error", () => {
      // Status reporting is strictly fail-open.
    });
    socket.once("close", () => {
      if (this.#socket === socket) this.#socket = undefined;
      this.#ready = false;
      this.#scheduleReconnect();
    });
  }

  #flush(): void {
    if (!this.#ready || !this.#socket?.writable) return;
    while (this.#queue.length > 0) {
      const event = this.#queue[0]!;
      if (!this.#write({ kind: "event", ...event })) return;
      this.#queue.shift();
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, RECONNECT_DELAY_MS);
    this.#reconnectTimer.unref?.();
  }
}

/** Bundled lifecycle-only Pi extension. It never reports prompt or tool payload data. */
export default function piDashRuntimeExtension(pi: ExtensionApiLike): void {
  if (
    !pi ||
    typeof pi.on !== "function" ||
    !pi.events ||
    typeof pi.events.on !== "function"
  ) {
    return;
  }
  const safeOn = (
    event: string,
    handler: (...args: unknown[]) => void,
  ): void => {
    try {
      pi.on(event, handler);
    } catch {
      // Unsupported lifecycle APIs degrade status without affecting Pi.
    }
  };
  const extensionInstanceId = randomUUID();
  let client: FailOpenStatusClient | undefined;
  let agentActive = false;
  let settledCompletionId: string | undefined;
  const blockingInteractions = new Map<string, "ask_user">();

  const snapshot = () => ({
    agentActive,
    settledCompletionId,
    blockingInteractions: [...blockingInteractions].map(([id, reason]) => ({
      id,
      reason,
    })),
  });

  safeOn("session_start", () => {
    const config = readConfiguration();
    if (!config) return;
    client ??= new FailOpenStatusClient(config, extensionInstanceId, snapshot);
    client.start();
  });

  safeOn("agent_start", () => {
    agentActive = true;
    settledCompletionId = undefined;
    blockingInteractions.clear();
    client?.report({ event: "agent_start" });
  });

  safeOn("agent_settled", () => {
    agentActive = false;
    settledCompletionId = randomUUID();
    blockingInteractions.clear();
    client?.report({
      event: "agent_settled",
      completionId: settledCompletionId,
    });
  });

  const attentionHandler = (value: unknown) => {
    const event: PiDashAttentionEvent | undefined = parseAttentionEvent(value);
    if (!event || !agentActive) return;
    if (event.phase === "start") {
      blockingInteractions.set(event.interactionId, event.reason);
      client?.report({
        event: "blocking_wait_start",
        interactionId: event.interactionId,
        reason: event.reason,
      });
      return;
    }
    if (!blockingInteractions.delete(event.interactionId)) return;
    client?.report({
      event: "blocking_wait_end",
      interactionId: event.interactionId,
      reason: event.reason,
    });
  };
  try {
    pi.events.on(PI_DASH_ATTENTION_EVENT, attentionHandler);
  } catch {
    // Lifecycle reporting still works when the shared event bus is unavailable.
  }

  safeOn("session_shutdown", () => {
    try {
      pi.events.off?.(PI_DASH_ATTENTION_EVENT, attentionHandler);
    } catch {
      // Shared event bus cleanup is idempotent and fail-open.
    }
    agentActive = false;
    settledCompletionId = undefined;
    blockingInteractions.clear();
    client?.shutdown();
    client = undefined;
  });
}
