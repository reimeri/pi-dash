#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

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
process.stdin.on("data", (chunk) => {
  const data = chunk.toString("utf8");
  if (data.includes("__CRASH__")) process.exit(7);
  if (data.includes("__EXIT__")) process.exit(0);
  process.stdout.write(data);
});
process.on("SIGTERM", () => process.exit(0));
