#!/usr/bin/env node
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";

const statusSocket = process.env.PI_DASH_STATUS_SOCKET;
const runtimeId = process.env.PI_DASH_RUNTIME_ID;
const token = process.env.PI_DASH_STATUS_TOKEN;
const status = statusSocket && runtimeId && token ? createConnection(statusSocket) : undefined;
const sendStatus = (event: string, interactionId?: string, reason?: string) => {
  status?.write(`${JSON.stringify({ v: 0, runtimeId, token, event, interactionId, reason })}\n`);
};
status?.once("connect", () => sendStatus("session_start"));
status?.once("error", () => undefined);

process.stdout.write("\u001b[?1049h\u001b[2J\u001b[HPI_DASH_FAKE_READY\r\nType text, resize, refresh, or enter exit[:code].\r\n> ");
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let input = "";

process.on("SIGWINCH", () => {
  process.stdout.write(`\r\nRESIZE:${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}\r\n> ${input}`);
});
process.on("SIGTERM", () => {
  sendStatus("session_shutdown");
  status?.end();
  process.stdout.write("\r\nFAKE_SIGTERM\u001b[?1049l");
  process.exit(0);
});

async function emitSustainedOutput(): Promise<void> {
  const bytesPerSecond = 5 * 1024 * 1024;
  const totalBytes = bytesPerSecond * 30;
  const block = "0123456789abcdef".repeat(4096);
  const chunks = Math.ceil(totalBytes / Buffer.byteLength(block));
  const started = performance.now();
  for (let index = 0; index < chunks; index++) {
    if (!process.stdout.write(block)) await once(process.stdout, "drain");
    const expectedElapsed = ((index + 1) * Buffer.byteLength(block) * 1000) / bytesPerSecond;
    const delay = expectedElapsed - (performance.now() - started);
    if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
  }
  process.stdout.write("\r\nSUSTAIN_DONE\r\n> ");
}

function emitPulse(): void {
  let remaining = 100;
  const timer = setInterval(() => {
    process.stdout.write(`PULSE:${remaining}:${"x".repeat(512)}\r\n`);
    remaining--;
    if (remaining === 0) {
      clearInterval(timer);
      process.stdout.write("PULSE_DONE\r\n> ");
    }
  }, 2);
}

process.stdin.on("data", (chunk) => {
  input += chunk;
  process.stdout.write(chunk);
  if (input.includes("flood")) {
    input = "";
    const block = "0123456789abcdef".repeat(1024);
    for (let index = 0; index < 320; index++) process.stdout.write(block);
    process.stdout.write("\r\nFLOOD_DONE\r\n> ");
    return;
  }
  if (input.includes("sustain")) {
    input = "";
    void emitSustainedOutput();
    return;
  }
  if (input.includes("pulse")) {
    input = "";
    emitPulse();
    return;
  }
  if (input.includes("child")) {
    input = "";
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    process.stdout.write(`\r\nCHILD_PID:${child.pid}\r\n> `);
    return;
  }
  if (input.includes("status")) {
    input = "";
    const interactionId = "fake-interaction";
    sendStatus("agent_start");
    setTimeout(() => sendStatus("blocking_wait_start", interactionId, "ask_user"), 100);
    setTimeout(() => sendStatus("blocking_wait_end", interactionId, "ask_user"), 500);
    setTimeout(() => sendStatus("agent_settled"), 750);
    process.stdout.write("\r\nSTATUS_SEQUENCE_SENT\r\n> ");
    return;
  }
  const match = input.match(/exit(?::(\d+))?[\r\n]/);
  if (match) {
    process.stdout.write("\r\nFAKE_EXIT\u001b[?1049l");
    process.exit(Number(match[1] ?? 0));
  }
  if (input.endsWith("\r") || input.endsWith("\n")) {
    input = "";
    process.stdout.write("\r\n> ");
  }
});
