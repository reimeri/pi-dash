import type {
  ApplicationEventsServerFrame,
  RuntimeDto,
  WorkflowStatusDto,
  WorkspaceAttentionDto,
} from "@pi-dash/contracts";

export interface ApplicationEventTransport {
  readonly bufferedAmount: number;
  send(frame: ApplicationEventsServerFrame): void;
  close(code: number, reason: string): void;
}

interface Subscriber {
  transport: ApplicationEventTransport;
  snapshotSent: boolean;
}

export interface ApplicationEvents {
  readonly cursor: number;
  publishStatus(status: WorkflowStatusDto): void;
  publishRuntime(runtime: RuntimeDto): void;
  subscribe(transport: ApplicationEventTransport): () => void;
  close(): void;
}

export function createApplicationEvents(options: {
  statuses: () => WorkflowStatusDto[];
  runtimes: () => RuntimeDto[];
  workspaceAttention: () => WorkspaceAttentionDto[];
  maxBufferedBytes?: number;
}): ApplicationEvents {
  const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  const subscribers = new Set<Subscriber>();
  let cursor = 0;

  function send(
    subscriber: Subscriber,
    frame: ApplicationEventsServerFrame,
  ): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (subscriber.transport.bufferedAmount + bytes > maxBufferedBytes) {
      subscriber.transport.close(
        1013,
        "Application event client is not draining",
      );
      subscribers.delete(subscriber);
      return false;
    }
    try {
      subscriber.transport.send(frame);
      return true;
    } catch {
      subscribers.delete(subscriber);
      return false;
    }
  }

  function append(frame: ApplicationEventsServerFrame): void {
    for (const subscriber of subscribers) {
      if (subscriber.snapshotSent) send(subscriber, frame);
    }
  }

  return {
    get cursor() {
      return cursor;
    },
    publishStatus(status) {
      cursor += 1;
      append({
        v: 1,
        type: "status",
        cursor,
        status,
        workspaceAttention: options.workspaceAttention(),
      });
    },
    publishRuntime(runtime) {
      cursor += 1;
      append({ v: 1, type: "runtime", cursor, runtime });
    },
    subscribe(transport) {
      const subscriber: Subscriber = { transport, snapshotSent: false };
      subscribers.add(subscriber);
      const snapshotCursor = cursor;
      send(subscriber, {
        v: 1,
        type: "snapshot",
        cursor: snapshotCursor,
        statuses: options.statuses(),
        runtimes: options.runtimes(),
        workspaceAttention: options.workspaceAttention(),
      });
      subscriber.snapshotSent = true;
      return () => subscribers.delete(subscriber);
    },
    close() {
      for (const subscriber of subscribers) {
        subscriber.transport.close(1001, "Application event stream closed");
      }
      subscribers.clear();
    },
  };
}
