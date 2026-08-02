#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";

if (process.argv.includes("--version")) {
  process.stdout.write("pi 0.83.0\n");
  process.exit(0);
}

const statFields = readFileSync(`/proc/${process.pid}/stat`, "utf8")
  .slice(readFileSync(`/proc/${process.pid}/stat`, "utf8").lastIndexOf(")") + 2)
  .trim()
  .split(/\s+/);
const processGroup = Number(statFields[2]);

process.stdin.setRawMode?.(true);
process.stdin.resume();

let statusSocket: Socket | undefined;
let statusSequence = 0;
const extensionInstanceId = randomUUID();
const statusBase = {
  v: 1,
  runtimeId: process.env.PI_DASH_RUNTIME_ID,
  worktreeId: process.env.PI_DASH_WORKTREE_ID,
  token: process.env.PI_DASH_STATUS_TOKEN,
  extensionInstanceId,
};
const interactionId = "99999999-9999-4999-8999-999999999999";
let settledCompletionId: string | undefined;
function reportStatus(payload: Record<string, unknown>) {
  if (!statusSocket?.writable) return;
  statusSequence += 1;
  statusSocket.write(
    `${JSON.stringify({ ...statusBase, seq: statusSequence, timestamp: new Date().toISOString(), ...payload })}\n`,
  );
}
if (process.env.FAKE_PI_STATUS === "1" && process.env.PI_DASH_STATUS_SOCKET) {
  statusSocket = createConnection(process.env.PI_DASH_STATUS_SOCKET);
  statusSocket.on("error", () => undefined);
  statusSocket.on("connect", () => {
    reportStatus({ kind: "event", event: "session_start" });
    reportStatus({
      kind: "snapshot",
      agentActive: false,
      blockingInteractions: [],
    });
  });
}
process.stdout.write(
  `FAKE_PI_READY ${JSON.stringify({
    pid: process.pid,
    processGroup,
    cwd: process.cwd(),
    extension: process.argv[process.argv.indexOf("--extension") + 1] ?? null,
    dashVariables: Object.keys(process.env)
      .filter((key) => key.startsWith("PI_DASH_"))
      .sort(),
  })}\r\n`,
);

if (process.env.FAKE_PI_CHILD_CHURN === "1") {
  const churn = setInterval(() => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("error", () => undefined);
  }, 5);
  churn.unref();
}

if (process.env.FAKE_PI_ORPHAN === "1") {
  const orphanCode =
    'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},1000)';
  const intermediateCode = `
    const { spawn } = require("node:child_process");
    const orphan = spawn(process.execPath, ["-e", ${JSON.stringify(orphanCode)}], { stdio: "ignore" });
    process.stdout.write("FAKE_PI_ORPHAN " + orphan.pid + "\\n");
  `;
  const intermediate = spawn(process.execPath, ["-e", intermediateCode], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  intermediate.stdout.on("data", (data) => process.stdout.write(data));
}

if (process.env.FAKE_PI_CHILD_TREE === "1") {
  const grandchildCode =
    'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},1000)';
  const childCode = `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: "ignore" });
    process.stdout.write("FAKE_PI_TREE " + process.pid + " " + grandchild.pid + "\\n");
    process.on("SIGTERM", () => {});
    process.on("SIGHUP", () => {});
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", childCode], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.on("data", (data) => process.stdout.write(data));
}
process.stdout.on("resize", () => {
  process.stdout.write(
    `FAKE_PI_SIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`,
  );
});

let inputBuffer = "";
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  inputBuffer = `${inputBuffer}${data}`.slice(-256);
  if (inputBuffer.includes("__WORKING__")) {
    settledCompletionId = undefined;
    reportStatus({ kind: "event", event: "agent_start" });
    inputBuffer = inputBuffer.replace("__WORKING__", "");
  }
  if (inputBuffer.includes("__BLOCK_START__")) {
    reportStatus({
      kind: "event",
      event: "blocking_wait_start",
      interactionId,
      reason: "ask_user",
    });
    inputBuffer = inputBuffer.replace("__BLOCK_START__", "");
  }
  if (inputBuffer.includes("__BLOCK_END__")) {
    reportStatus({
      kind: "event",
      event: "blocking_wait_end",
      interactionId,
      reason: "ask_user",
    });
    inputBuffer = inputBuffer.replace("__BLOCK_END__", "");
  }
  if (inputBuffer.includes("__SETTLED__")) {
    settledCompletionId ??= randomUUID();
    reportStatus({
      kind: "event",
      event: "agent_settled",
      completionId: settledCompletionId,
    });
    inputBuffer = inputBuffer.replace("__SETTLED__", "");
  }
  if (inputBuffer.includes("__CRASH__")) process.exit(7);
  if (inputBuffer.includes("__EXIT__")) process.exit(0);
  process.stdout.write(data);
});
process.on("SIGTERM", () => {
  reportStatus({ kind: "event", event: "session_shutdown" });
  statusSocket?.end();
  process.exit(0);
});
