import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piDashRuntimeExtension from "../src/runtime.js";

const roots: string[] = [];
const priorEnvironment = {
  socket: process.env.PI_DASH_STATUS_SOCKET,
  runtime: process.env.PI_DASH_RUNTIME_ID,
  worktree: process.env.PI_DASH_WORKTREE_ID,
  token: process.env.PI_DASH_STATUS_TOKEN,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore("PI_DASH_STATUS_SOCKET", priorEnvironment.socket);
  restore("PI_DASH_RUNTIME_ID", priorEnvironment.runtime);
  restore("PI_DASH_WORKTREE_ID", priorEnvironment.worktree);
  restore("PI_DASH_STATUS_TOKEN", priorEnvironment.token);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for frames");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("bundled status extension", () => {
  it("fails open when Pi lifecycle APIs are unsupported", () => {
    expect(() => piDashRuntimeExtension({} as never)).not.toThrow();
    expect(() =>
      piDashRuntimeExtension({
        on() {
          throw new Error("unsupported");
        },
        events: {
          on() {
            throw new Error("unsupported");
          },
        },
      }),
    ).not.toThrow();
  });

  it("reports only ordered lifecycle metadata and exact attention waits", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-extension-"));
    roots.push(root);
    const socketPath = join(root, "status.sock");
    const frames: Array<Record<string, unknown>> = [];
    let acceptedSocket: Socket | undefined;
    const server: Server = createServer((socket) => {
      acceptedSocket = socket;
      let pending = "";
      socket.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line) frames.push(JSON.parse(line) as Record<string, unknown>);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    process.env.PI_DASH_STATUS_SOCKET = socketPath;
    process.env.PI_DASH_RUNTIME_ID = "11111111-1111-4111-8111-111111111111";
    process.env.PI_DASH_WORKTREE_ID = "22222222-2222-4222-8222-222222222222";
    process.env.PI_DASH_STATUS_TOKEN = "t".repeat(43);

    const handlers = new Map<string, (...args: unknown[]) => void>();
    let attentionHandler: ((data: unknown) => void) | undefined;
    piDashRuntimeExtension({
      on(event, handler) {
        handlers.set(event, handler);
      },
      events: {
        on(event, handler) {
          if (event === "pi-dash:attention") attentionHandler = handler;
        },
      },
    });

    handlers.get("session_start")?.();
    await waitFor(() => frames.length >= 2);
    handlers.get("agent_start")?.();
    const interactionId = "33333333-3333-4333-8333-333333333333";
    attentionHandler?.({
      phase: "start",
      interactionId,
      reason: "ask_user",
      prompt: "must never leave Pi",
    });
    attentionHandler?.({
      phase: "end",
      interactionId,
      reason: "ask_user",
      answer: "must never leave Pi",
    });
    handlers.get("agent_settled")?.();
    await waitFor(() => frames.length >= 6);

    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(frames.map((frame) => frame.event ?? frame.kind)).toEqual([
      "session_start",
      "snapshot",
      "agent_start",
      "blocking_wait_start",
      "blocking_wait_end",
      "agent_settled",
    ]);
    expect(JSON.stringify(frames)).not.toContain("must never leave Pi");
    expect(new Set(frames.map((frame) => frame.extensionInstanceId)).size).toBe(
      1,
    );

    acceptedSocket?.destroy();
    handlers.get("agent_start")?.();
    attentionHandler?.({
      phase: "start",
      interactionId,
      reason: "ask_user",
    });
    await waitFor(() => frames.length >= 8);
    expect(
      frames.slice(6, 8).map((frame) => frame.event ?? frame.kind),
    ).toEqual(["session_start", "snapshot"]);
    expect(frames[7]).toMatchObject({
      agentActive: true,
      blockingInteractions: [{ id: interactionId, reason: "ask_user" }],
    });

    acceptedSocket?.destroy();
    handlers.get("agent_settled")?.();
    await waitFor(() => frames.length >= 11);
    expect(
      frames.slice(8, 11).map((frame) => frame.event ?? frame.kind),
    ).toEqual(["session_start", "snapshot", "agent_settled"]);

    handlers.get("session_shutdown")?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
