import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createSpikeServer, type SpikeServer } from "../../src/server.js";
import type { ServerFrame } from "../../src/protocol.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
let server: SpikeServer | undefined;

class FrameQueue {
  readonly frames: ServerFrame[] = [];
  readonly waiters = new Set<() => void>();

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: RawData) => {
      this.frames.push(JSON.parse(raw.toString()) as ServerFrame);
      for (const wake of this.waiters) wake();
    });
  }

  async next(predicate: (frame: ServerFrame) => boolean, timeoutMs = 5_000): Promise<ServerFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return existing;
    return new Promise<ServerFrame>((resolveFrame, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out waiting for frame; received ${this.frames.map((frame) => frame.type).join(", ")}`));
      }, timeoutMs);
      const check = () => {
        const frame = this.frames.find(predicate);
        if (!frame) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolveFrame(frame);
      };
      this.waiters.add(check);
    });
  }
}

async function connect(address: string, options: WebSocket.ClientOptions = {}): Promise<FrameQueue> {
  const socket = new WebSocket(address.replace("http", "ws") + "/spike/terminal", options);
  const queue = new FrameQueue(socket);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return queue;
}

async function diagnostics(address: string): Promise<any> {
  const response = await fetch(`${address}/spike/diagnostics`);
  expect(response.ok).toBe(true);
  return response.json();
}

async function waitForDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return false;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("terminal bridge server", () => {
  it("validates that cwd is exactly a Git top level", async () => {
    await expect(
      createSpikeServer({ cwd: resolve(repositoryRoot, "spikes/terminal-bridge"), fixture: true, port: 0, serveClient: false }),
    ).rejects.toThrow(/Git top level/);
  });

  it("bridges input exactly once with localhost p95 below 50 ms", async () => {
    server = await createSpikeServer({ cwd: repositoryRoot, fixture: true, port: 0, serveClient: false });
    const client = await connect(server.address);
    const hello = (await client.next((frame) => frame.type === "hello")) as Extract<ServerFrame, { type: "hello" }>;
    client.socket.send(JSON.stringify({ v: 0, type: "replayFrom", seq: hello.earliestSeq }));
    await client.next((frame) => frame.type === "output" && frame.data.includes("PI_DASH_FAKE_READY"));

    const durations: number[] = [];
    for (let index = 0; index < 20; index++) {
      const token = `echo-${index}-${Math.random().toString(36).slice(2)}`;
      const started = performance.now();
      client.socket.send(JSON.stringify({ v: 0, type: "input", data: `${token}\r` }));
      await client.next((frame) => frame.type === "output" && frame.data.includes(token));
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    console.info("INPUT_ECHO_P95_MS", p95.toFixed(2));
    expect(p95).toBeLessThanOrEqual(50);
    expect(client.frames.filter((frame) => frame.type === "output" && frame.data.includes("echo-0-")).length).toBe(1);
    client.socket.close();
  });

  it("keeps the PTY alive across disconnect and provides bounded replay/reset", async () => {
    server = await createSpikeServer({
      cwd: repositoryRoot,
      fixture: true,
      port: 0,
      serveClient: false,
      outputBufferBytes: 4_096,
    });
    const first = await connect(server.address);
    const hello = (await first.next((frame) => frame.type === "hello")) as Extract<ServerFrame, { type: "hello" }>;
    first.socket.send(JSON.stringify({ v: 0, type: "replayFrom", seq: hello.earliestSeq }));
    await first.next((frame) => frame.type === "output");
    first.socket.close();
    await new Promise((resolveClose) => first.socket.once("close", resolveClose));
    expect(() => process.kill(server!.runtimePid, 0)).not.toThrow();

    const second = await connect(server.address);
    const secondHello = (await second.next((frame) => frame.type === "hello")) as Extract<ServerFrame, { type: "hello" }>;
    second.socket.send(JSON.stringify({ v: 0, type: "replayFrom", seq: secondHello.earliestSeq }));
    await second.next((frame) => frame.type === "output");
    second.socket.send(JSON.stringify({ v: 0, type: "input", data: "flood\r" }));
    await second.next((frame) => frame.type === "output" && frame.data.includes("FLOOD_DONE"), 10_000);
    const afterFlood = await diagnostics(server.address);
    expect(afterFlood.terminal.bufferedBytes).toBeLessThanOrEqual(4_096);
    expect(afterFlood.terminal.earliestSeq).toBeGreaterThan(1);
    second.socket.send(JSON.stringify({ v: 0, type: "replayFrom", seq: 1 }));
    await second.next((frame) => frame.type === "replayReset");
    second.socket.close();
  });

  it("gates live output until replay is atomically attached", async () => {
    server = await createSpikeServer({ cwd: repositoryRoot, fixture: true, port: 0, serveClient: false });
    const producer = await connect(server.address);
    const producerHello = (await producer.next((frame) => frame.type === "hello")) as Extract<ServerFrame, { type: "hello" }>;
    producer.socket.send(JSON.stringify({ v: 0, type: "replayFrom", seq: producerHello.earliestSeq }));
    await producer.next((frame) => frame.type === "output" && frame.data.includes("PI_DASH_FAKE_READY"));
    producer.socket.send(JSON.stringify({ v: 0, type: "input", data: "pulse\r" }));
    await producer.next((frame) => frame.type === "output" && frame.data.includes("PULSE:"));

    const reconnecting = await connect(server.address);
    const hello = (await reconnecting.next((frame) => frame.type === "hello")) as Extract<ServerFrame, { type: "hello" }>;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(reconnecting.frames.some((frame) => frame.type === "output")).toBe(false);

    reconnecting.socket.send(JSON.stringify({ v: 0, type: "replayFrom", seq: hello.earliestSeq }));
    await reconnecting.next((frame) => frame.type === "output" && frame.data.includes("PULSE_DONE"));
    const sequences = reconnecting.frames
      .filter((frame): frame is Extract<ServerFrame, { type: "output" }> => frame.type === "output")
      .map((frame) => frame.seq);
    expect(sequences.length).toBeGreaterThan(2);
    for (let index = 1; index < sequences.length; index++) expect(sequences[index]).toBe(sequences[index - 1]! + 1);
    producer.socket.close();
    reconnecting.socket.close();
  });

  it("reports a degraded status capability when no extension authenticates", async () => {
    server = await createSpikeServer({
      cwd: repositoryRoot,
      fixture: true,
      disableStatusFixture: true,
      port: 0,
      serveClient: false,
    });
    const client = await connect(server.address);
    await client.next(
      (frame) => frame.type === "status" && frame.capability === "degraded",
      3_000,
    );
    expect((await diagnostics(server.address)).status.capability).toBe("degraded");
    client.socket.close();
  });

  it("authenticates status frames and reports the lifecycle sequence", async () => {
    server = await createSpikeServer({ cwd: repositoryRoot, fixture: true, port: 0, serveClient: false });
    const client = await connect(server.address);
    await client.next((frame) => frame.type === "status" && frame.event === "session_start");

    await new Promise<void>((resolveConnect, reject) => {
      const attacker = createConnection(server!.statusSocketPath);
      attacker.once("connect", () => {
        attacker.end(`${JSON.stringify({ v: 0, runtimeId: server!.runtimeId, token: "wrong", event: "agent_start" })}\n`);
        resolveConnect();
      });
      attacker.once("error", reject);
    });
    client.socket.send(JSON.stringify({ v: 0, type: "input", data: "status\r" }));
    await client.next((frame) => frame.type === "status" && frame.event === "agent_start");
    await client.next((frame) => frame.type === "status" && frame.event === "blocking_wait_start" && frame.state === "blocked");
    await client.next((frame) => frame.type === "status" && frame.event === "blocking_wait_end" && frame.state === "working");
    await client.next((frame) => frame.type === "status" && frame.event === "agent_settled" && frame.state === "done");
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const snapshot = await diagnostics(server.address);
    expect(snapshot.resources.statusEventsRejected).toBe(1);
    expect(snapshot.status.state).toBe("done");
    client.socket.close();
  });

  it("rejects malformed frames, enforces Origin, and cleans process/socket resources", async () => {
    server = await createSpikeServer({ cwd: repositoryRoot, fixture: true, port: 0, serveClient: false });
    const client = await connect(server.address);
    const hello = (await client.next((frame) => frame.type === "hello")) as Extract<ServerFrame, { type: "hello" }>;
    client.socket.send(JSON.stringify({ v: 0, type: "replayFrom", seq: hello.earliestSeq }));
    await client.next((frame) => frame.type === "output" && frame.data.includes("PI_DASH_FAKE_READY"));
    client.socket.send("not json");
    await client.next((frame) => frame.type === "error" && frame.code === "INVALID_JSON");
    client.socket.send(JSON.stringify({ v: 0, type: "resize", cols: 0, rows: 20 }));
    await client.next((frame) => frame.type === "error" && frame.code === "INVALID_RESIZE");

    const foreign = new WebSocket(server.address.replace("http", "ws") + "/spike/terminal", {
      origin: "https://attacker.example",
    });
    const closeCode = await new Promise<number>((resolveClose) => foreign.once("close", resolveClose));
    expect(closeCode).toBe(1008);

    client.socket.send(JSON.stringify({ v: 0, type: "input", data: "child\r" }));
    const childOutput = (await client.next(
      (frame) => frame.type === "output" && frame.data.includes("CHILD_PID:"),
    )) as Extract<ServerFrame, { type: "output" }>;
    const childPid = Number(childOutput.data.match(/CHILD_PID:(\d+)/)?.[1]);
    expect(childPid).toBeGreaterThan(0);
    await expect
      .poll(async () => (await diagnostics(server!.address)).resources.trackedProcessMembers)
      .toBeGreaterThanOrEqual(2);
    client.socket.send(JSON.stringify({ v: 0, type: "input", data: "exit:0\r" }));
    await client.next((frame) => frame.type === "runtime" && frame.state === "exited");

    const pid = server.runtimePid;
    const socketPath = server.statusSocketPath;
    client.socket.close();
    await server.close();
    server = undefined;
    expect(await waitForDead(pid)).toBe(true);
    expect(await waitForDead(childPid)).toBe(true);
    await expect(access(socketPath)).rejects.toThrow();
  });
});
