import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon } from "../src/daemon.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function options(root: string) {
  return {
    args: [
      "--data-dir",
      join(root, "data"),
      "--config-dir",
      join(root, "config"),
      "--runtime-dir",
      join(root, "runtime"),
      "--bootstrap-output",
      join(root, "runtime", "bootstrap-url"),
      "--port",
      "4399",
    ],
    env: { NODE_ENV: "test" },
    logger: pino({ level: "silent" }),
  };
}

describe("daemon lifecycle", () => {
  it("rejects a second process while the kernel lock is held", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-daemon-process-"));
    roots.push(root);
    const holder = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./daemon-holder.ts", import.meta.url)),
        root,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    holder.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        holder.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("locked")) resolveReady();
        });
        holder.once("exit", (code) =>
          rejectReady(new Error(`Lock holder exited ${code}: ${stderr}`)),
        );
      });
      await expect(createDaemon(options(root))).rejects.toThrow(
        "Another pi-dash daemon owns",
      );
    } finally {
      const exited = new Promise<void>((resolveExit) =>
        holder.once("exit", () => resolveExit()),
      );
      holder.kill("SIGTERM");
      await exited;
    }
  });

  it("holds an exclusive data-root lock, recovers stale metadata, and shuts down idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-daemon-"));
    roots.push(root);
    const first = await createDaemon(options(root));
    first.markReady();
    expect(existsSync(first.paths.runtimeInfo)).toBe(true);
    await expect(createDaemon(options(root))).rejects.toThrow(
      "Another pi-dash daemon owns",
    );
    await first.shutdown();
    await first.shutdown();
    expect(existsSync(first.paths.runtimeInfo)).toBe(false);
    expect(existsSync(join(root, "runtime", "bootstrap-url"))).toBe(false);

    writeFileSync(first.paths.lock, '{"pid":999999}\n', { mode: 0o600 });
    const recovered = await createDaemon(options(root));
    await recovered.shutdown();
  });
});
