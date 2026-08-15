import { afterEach, describe, expect, it, vi } from "vitest";
import { createStatusEventClient } from "../src/lib/status/events.js";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
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
}

afterEach(() => {
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
    sockets[0]!.close(4001, "Session expired");
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
    sockets[0]!.close(1006);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    client.close();
  });
});
