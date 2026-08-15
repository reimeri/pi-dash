import { APPLICATION_EVENTS_PROTOCOL_VERSION } from "@pi-dash/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatusEventClient } from "../src/lib/status/events.js";
import { workflowStatusStore } from "../src/lib/status/store.js";
import {
  CLIENT_PROTOCOL_ERROR_CLOSE_CODE,
  CLIENT_RECONNECT_CLOSE_CODE,
} from "../src/lib/websocket-close-codes.js";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];
  readonly clientCloses: Array<{ code: number; reason: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new RangeError(`Invalid browser WebSocket close code: ${code}`);
    }
    this.clientCloses.push({ code, reason });
    this.serverClose(code, reason);
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    const event = new Event("close") as Event & {
      code: number;
      reason: string;
    };
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }

  message(data: string): void {
    const event = new Event("message") as Event & { data: string };
    Object.defineProperty(event, "data", { value: data });
    this.dispatchEvent(event);
  }
}

afterEach(() => {
  workflowStatusStore.reset();
  vi.useRealTimers();
});

describe("status event authentication recovery", () => {
  it("delegates an expired remote session without retrying stale credentials", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const onAuthenticationRequired = vi.fn();
    const client = createStatusEventClient({
      url: () =>
        "wss://pi-dash-host.example-tailnet.ts.net/api/v1/events/socket",
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onAuthenticationRequired,
    });

    client.start();
    expect(sockets).toHaveLength(1);
    sockets[0]!.serverClose(4001, "Session expired");
    expect(onAuthenticationRequired).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    client.close();
  });

  it("retains bounded reconnect for ordinary disconnects", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = createStatusEventClient({
      url: () => "ws://127.0.0.1:4317/api/v1/events/socket",
      reconnectBaseMs: 500,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    client.start();
    sockets[0]!.serverClose(1006);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    client.close();
  });

  it.each([
    ["malformed", "not json", CLIENT_PROTOCOL_ERROR_CLOSE_CODE],
    [
      "invalid",
      JSON.stringify({ type: "unknown" }),
      CLIENT_PROTOCOL_ERROR_CLOSE_CODE,
    ],
    [
      "resync",
      JSON.stringify({
        v: APPLICATION_EVENTS_PROTOCOL_VERSION,
        type: "resyncRequired",
        latestCursor: 0,
      }),
      CLIENT_RECONNECT_CLOSE_CODE,
    ],
  ])(
    "uses a valid application close code for %s frames",
    (_name, frame, code) => {
      vi.useFakeTimers();
      const socket = new FakeSocket();
      const client = createStatusEventClient({
        url: () => "ws://127.0.0.1/events/socket",
        createSocket: () => socket as unknown as WebSocket,
      });

      client.start();
      expect(() => socket.message(frame)).not.toThrow();
      expect(socket.clientCloses).toHaveLength(1);
      expect(socket.clientCloses[0]?.code).toBe(code);
      expect(socket.clientCloses[0]?.reason).not.toBe("");
      client.close();
    },
  );

  it("ignores messages and errors from a superseded socket", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const onSnapshot = vi.fn();
    const client = createStatusEventClient({
      url: () => "ws://127.0.0.1/events/socket",
      reconnectBaseMs: 1,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onSnapshot,
    });

    client.start();
    sockets[0]!.serverClose(1006);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(workflowStatusStore.current().channel).toBe("connecting");

    sockets[0]!.message(
      JSON.stringify({
        v: APPLICATION_EVENTS_PROTOCOL_VERSION,
        type: "snapshot",
        cursor: 0,
        statuses: [],
        runtimes: [],
        shellActivities: [],
        workspaceAttention: [],
        environmentChanges: [],
      }),
    );
    sockets[0]!.dispatchEvent(new Event("error"));

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(workflowStatusStore.current().channel).toBe("connecting");
    client.close();
  });
});
