#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

if (process.argv.includes("--version")) {
  process.stdout.write("pi 0.83.0\n");
  process.exit(0);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();

let statusSocket;
let statusSequence = 0;
const statusBase = {
  v: 1,
  runtimeId: process.env.PI_DASH_RUNTIME_ID,
  worktreeId: process.env.PI_DASH_WORKTREE_ID,
  token: process.env.PI_DASH_STATUS_TOKEN,
  extensionInstanceId: randomUUID(),
};

function reportStatus(payload) {
  if (!statusSocket?.writable) return;
  statusSequence += 1;
  statusSocket.write(
    `${JSON.stringify({
      ...statusBase,
      seq: statusSequence,
      timestamp: new Date().toISOString(),
      ...payload,
    })}\n`,
  );
}

const reset = "\u001b[0m";
const bold = "\u001b[1m";
const italic = "\u001b[3m";
const foreground = "\u001b[38;2;228;228;231m";
const muted = "\u001b[38;2;113;113;122m";
const blue = "\u001b[38;2;125;211;252m";
const cyan = "\u001b[38;2;94;234;212m";
const green = "\u001b[38;2;163;230;53m";
const yellow = "\u001b[38;2;251;191;36m";

function renderDemo() {
  const columns = Math.max(1, process.stdout.columns ?? 100);
  const rows = Math.max(1, process.stdout.rows ?? 30);
  if (columns < 60 || rows < 46) {
    const compactLines = ["Pi promotional demo", "", "Ready for review."].slice(
      0,
      rows,
    );
    process.stdout.write(
      `\u001b[2J\u001b[H\u001b[?25l${compactLines
        .map((line) => line.slice(0, columns))
        .join("\r\n")}`,
    );
    return;
  }
  const body = [
    `${blue}●${reset}${foreground} Read × 2${reset}${muted} ─ 2 done · ctrl+o to expand${reset}`,
    `${muted}├─ [41]${reset} Read scripts/capture-promo.mjs`,
    `${muted}└─ [42]${reset} Read scripts/fixtures/promo-pi.mjs`,
    "",
    `${italic}${muted}Planning a denser tool history for the staged session${reset}`,
    "",
    `${blue}●${reset}${foreground} Edit × 2${reset}${muted} ─ 2 done · ctrl+o to expand${reset}`,
    `${muted}├─ [43]${reset} Edit scripts/fixtures/promo-pi.mjs`,
    `${muted}└─ [44]${reset} Edit scripts/capture-promo.mjs`,
    "",
    `${italic}${muted}Matching tool groups, reasoning notes, and footer spacing${reset}`,
    "",
    `${blue}●${reset}${foreground} Write × 1${reset}${muted} ─ 1 done · ctrl+o to expand${reset}`,
    `${muted}└─ [45]${reset} Write dist/promo/pi-dash-app-terminal.png`,
    "",
    `${italic}${muted}Checking both generated frames at native resolution${reset}`,
    "",
    `${blue}●${reset}${foreground} Bash × 2${reset}${muted} ─ 2 done · ctrl+o to expand${reset}`,
    `${muted}├─ [46]${reset} Bash node --check scripts/fixtures/promo-pi.mjs`,
    `${muted}└─ [47]${reset} Bash npm run lint`,
    "",
    `${italic}${muted}Recapturing after the terminal layout verification${reset}`,
    "",
    `${blue}●${reset}${foreground} Bash × 1${reset}${muted} ─ 1 done · ctrl+o to expand${reset}`,
    `${muted}└─ [48]${reset} Bash npm run capture:promo`,
    "",
    `${foreground}Updated the promotional terminal to mirror a real Pi session.${reset}`,
    "",
    `${bold}${yellow}### Updated${reset}`,
    `${cyan}-${reset} Collapsible tool-call history and completion counts`,
    `${cyan}-${reset} Pi-style planning notes and rendered response content`,
    `${cyan}-${reset} Persistent task, TODO, and model status footer`,
    "",
    `${bold}${yellow}### Verification${reset}`,
    `${cyan}-${reset} ${cyan}npm run capture:promo${reset}`,
    `${cyan}-${reset} ${cyan}npm run check${reset}`,
    `${cyan}-${reset} ${cyan}npm run lint${reset}`,
    "",
    `${foreground}Ready for review.${reset}`,
  ];
  const footerRow = rows - 5;
  const taskPrefix = "── Task: Match promotional terminal to real Pi UI ";
  const taskLine = `${taskPrefix}${"─".repeat(Math.max(0, columns - taskPrefix.length))}`;
  const leftStatus = "~/pi-dash (capture-tooling) · ↑13k ↓2k";
  const rightStatus = "gpt-5.6-so1 • high";
  const rightColumn = Math.max(
    leftStatus.length + 2,
    columns - rightStatus.length + 1,
  );
  const output = [
    "\u001b[2J\u001b[H\u001b[?25l",
    body.join("\r\n"),
    `\u001b[${footerRow};1H${cyan}TODO${reset} 5/5 ${muted}· /todos${reset}`,
    `\u001b[${footerRow + 1};1H${green}✓ All tracked work completed${reset}`,
    `\u001b[${footerRow + 2};1H${muted}${taskLine}${reset}`,
    `\u001b[${footerRow + 4};1H${muted}${"─".repeat(columns)}${reset}`,
    `\u001b[${rows};1H${muted}${leftStatus}${reset}`,
    `\u001b[${rows};${rightColumn}H${muted}${rightStatus}${reset}`,
  ];
  process.stdout.write(output.join(""));
}

if (process.env.PI_DASH_STATUS_SOCKET) {
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

let shuttingDown = false;
renderDemo();
process.stdout.on("resize", () => {
  if (!shuttingDown) renderDemo();
});
process.stdin.on("data", () => undefined);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  reportStatus({ kind: "event", event: "session_shutdown" });
  let finished = false;
  let timeout;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    process.exit(0);
  };
  timeout = setTimeout(finish, 250);
  process.stdout.write(`${reset}\u001b[?25h`, () => {
    if (!statusSocket || statusSocket.destroyed) {
      finish();
      return;
    }
    statusSocket.once("close", finish);
    statusSocket.end();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.on("SIGTERM", shutdown);
