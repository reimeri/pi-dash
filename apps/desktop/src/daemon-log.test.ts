import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDaemonLog,
  DaemonLog,
  resolveDaemonLogDirectory,
  sanitizeDaemonOutput,
} from "./daemon-log.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-daemon-log-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop daemon log", () => {
  it("uses the private XDG state directory and redacts credentials", () => {
    const root = temporaryRoot();
    const directory = resolveDaemonLogDirectory({ XDG_STATE_HOME: root });
    const log = new DaemonLog({
      directory,
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    log.write(
      "stdout",
      "Open Pi Dash: http://127.0.0.1:4317/auth/bootstrap?token=secret-value\n",
    );
    log.write("stderr", "authorization: Bearer hidden-value\n");
    log.write(
      "stdout",
      `${JSON.stringify({ cookie: "pi_dash_session=cookie-secret", nested: { baseSnapshotToken: "snapshot-secret", csrfToken: "csrf-secret", sessionId: "session-secret", statusToken: "status-secret", token: "token-secret" } })}\n`,
    );
    log.write("stderr", "PI_DASH_STATUS_TOKEN=environment-secret\n");
    const unicode = Buffer.from("split 🙂 character\n", "utf8");
    log.write("stdout", unicode.subarray(0, 8));
    log.write("stdout", unicode.subarray(8));
    log.write("stderr", `${"x".repeat(65_530)} statusToken=`);
    log.write("stderr", "boundary-secret\n");
    log.close();

    const output = readFileSync(log.path, "utf8");
    expect(output).toContain("2026-08-02T12:00:00.000Z [stdout]");
    expect(output).toContain("token=[Redacted]");
    expect(output).toContain("authorization: Bearer [Redacted]");
    expect(output).not.toContain("secret-value");
    expect(output).not.toContain("hidden-value");
    expect(output).not.toContain("cookie-secret");
    expect(output).not.toContain("snapshot-secret");
    expect(output).not.toContain("csrf-secret");
    expect(output).not.toContain("session-secret");
    expect(output).not.toContain("status-secret");
    expect(output).not.toContain("token-secret");
    expect(output).not.toContain("environment-secret");
    expect(output).not.toContain("boundary-secret");
    expect(output).toContain("[oversized line omitted]");
    expect(output).toContain("split 🙂 character");
    expect(output).not.toContain("�");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
  });

  it("rotates prior launches and files that reach their size bound", () => {
    const directory = join(temporaryRoot(), "logs");
    const first = new DaemonLog({
      directory,
      maxFileBytes: 1_000,
      fileCount: 5,
    });
    first.write("stderr", "first launch\n");
    first.close();

    const second = new DaemonLog({
      directory,
      maxFileBytes: 1_000,
      fileCount: 5,
    });
    second.write("stdout", "second launch\n");
    expect(readFileSync(join(directory, "daemon.1.log"), "utf8")).toContain(
      "first launch",
    );
    second.close();

    const bounded = new DaemonLog({
      directory,
      maxFileBytes: 220,
      fileCount: 5,
    });
    for (let index = 0; index < 8; index += 1) {
      bounded.write("stdout", `line ${index} ${"x".repeat(40)}\n`);
    }
    bounded.write("stderr", `${"🙂".repeat(1_000)}\n`);
    bounded.close();

    const files = readdirSync(directory).filter((name) =>
      /^daemon(?:\.\d+)?\.log$/.test(name),
    );
    expect(files.length).toBeLessThanOrEqual(5);
    for (const file of files) {
      const metadata = statSync(join(directory, file));
      expect(metadata.size).toBeLessThanOrEqual(220);
      expect(metadata.mode & 0o777).toBe(0o600);
    }
    expect(
      files.map((file) => readFileSync(join(directory, file), "utf8")).join(""),
    ).toContain("line 7");
  });

  it("falls back without throwing when the state directory is unavailable", () => {
    const root = temporaryRoot();
    const stateFile = join(root, "state-file");
    writeFileSync(stateFile, "not a directory");

    const log = createDaemonLog({ XDG_STATE_HOME: stateFile });
    expect(log.failure).toBeTruthy();
    expect(() => {
      log.write("stdout", "still running\n");
      log.close();
    }).not.toThrow();
  });

  it("sanitizes crash details independently of file logging", () => {
    expect(
      sanitizeDaemonOutput(
        "failed at /auth/bootstrap?token=one&next=true Authorization=two",
      ),
    ).toBe(
      "failed at /auth/bootstrap?token=[Redacted]&next=true Authorization=[Redacted]",
    );
  });
});
