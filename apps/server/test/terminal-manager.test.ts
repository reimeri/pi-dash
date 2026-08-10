import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalServerFrame } from "@pi-dash/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createPiResolver } from "../src/pi/pi-resolver.js";
import {
  createTerminalManager,
  TerminalManagerError,
} from "../src/terminal/terminal-manager.js";
import type { WorktreeLifecycleCoordinator } from "../src/worktrees/worktree-lifecycle.js";

const fakePi = fileURLToPath(
  new URL("../../../tests/fixtures/fake-pi.ts", import.meta.url),
);
const extensionPath = fileURLToPath(
  new URL("../../../packages/pi-extension/src/runtime.ts", import.meta.url),
);
const roots: string[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for terminal event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fixture(
  options: {
    childChurn?: boolean;
    childTree?: boolean;
    orphan?: boolean;
    statusFails?: boolean;
    shell?: boolean;
    beforeResolveLaunch?: (signal: AbortSignal) => Promise<void>;
    launchFailure?: Error;
  } = {},
) {
  chmodSync(fakePi, 0o755);
  const cwd = mkdtempSync(join(tmpdir(), "pi-dash-terminal-"));
  roots.push(cwd);
  const records = new Map([
    [
      "11111111-1111-4111-8111-111111111111",
      {
        id: "11111111-1111-4111-8111-111111111111",
        path: cwd,
        health: "healthy",
        lifecycle: "ready",
      },
    ],
    [
      "22222222-2222-4222-8222-222222222222",
      {
        id: "22222222-2222-4222-8222-222222222222",
        path: cwd,
        health: "healthy",
        lifecycle: "ready",
      },
    ],
  ]);
  const lifecycle: WorktreeLifecycleCoordinator = {
    claimRemoval: () => undefined,
    restoreReady: () => undefined,
    claimTerminalStart(id) {
      const record = records.get(id);
      return record?.lifecycle === "ready" ? (record as never) : undefined;
    },
    canStartTerminal(id) {
      return records.get(id)?.lifecycle === "ready";
    },
  };
  const pi = createPiResolver({
    executable: fakePi,
    minimumVersion: "0.83.0",
    extensionPath,
  });
  const inheritedEnv = {
    ...process.env,
    PI_DASH_BOOTSTRAP_TOKEN: "must-not-leak",
    ...(options.childChurn ? { FAKE_PI_CHILD_CHURN: "1" } : {}),
    ...(options.childTree ? { FAKE_PI_CHILD_TREE: "1" } : {}),
    ...(options.orphan ? { FAKE_PI_ORPHAN: "1" } : {}),
  };
  const manager = createTerminalManager({
    runtimeKind: options.shell ? "shell" : "pi",
    lifecycle,
    getWorktree(id) {
      const record = records.get(id);
      if (!record) throw new Error("missing worktree");
      return record;
    },
    async verifyWorktree(id) {
      const record = records.get(id);
      if (!record || record.lifecycle !== "ready")
        throw new Error("worktree not ready");
      return record;
    },
    resolveLaunch: async ({ worktreeId, runtimeId, statusToken, signal }) => {
      await options.beforeResolveLaunch?.(signal);
      if (options.launchFailure) throw options.launchFailure;
      const env = Object.fromEntries(
        Object.entries(inheritedEnv).filter(
          ([key, value]) => value !== undefined && !key.startsWith("PI_DASH_"),
        ),
      ) as Record<string, string>;
      if (options.shell) {
        return { executable: "/bin/sh", args: [], env };
      }
      const resolved = await pi.probe();
      return {
        executable: resolved.executable,
        args: ["--extension", resolved.extensionPath],
        env: {
          ...env,
          PI_DASH_STATUS_SOCKET: join(cwd, "status.sock"),
          PI_DASH_RUNTIME_ID: runtimeId,
          PI_DASH_WORKTREE_ID: worktreeId,
          PI_DASH_STATUS_TOKEN: statusToken,
        },
      };
    },
    processScope: options.shell ? "session" : "process-group",
    initialCols: 80,
    initialRows: 24,
    outputBufferBytes: 64 * 1024,
    maxSocketBufferedBytes: 1024 * 1024,
    stopGraceMs: 1_000,
    ...(options.shell
      ? {
          onShellActivity() {
            // The current value is exposed through manager.activities().
          },
        }
      : {}),
    ...(options.statusFails
      ? {
          status: {
            registerRuntime() {
              throw new Error("status registration failed");
            },
            resetRuntime() {
              throw new Error("status reset failed");
            },
          },
          onRuntimeState() {
            throw new Error("event fan-out failed");
          },
        }
      : {}),
  });
  return { manager, records };
}

async function startRunning(
  manager: ReturnType<typeof fixture>["manager"],
  worktreeId: string,
) {
  const starting = await manager.start(worktreeId);
  await waitFor(() => manager.get(worktreeId).state === "running");
  return { starting, running: manager.get(worktreeId) };
}

function transport() {
  const frames: TerminalServerFrame[] = [];
  return {
    frames,
    socket: {
      bufferedAmount: 0,
      send(frame: TerminalServerFrame) {
        frames.push(frame);
      },
      close() {},
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("terminal manager integration", () => {
  it("collapses starts, attaches while starting, and enforces one input owner", async () => {
    const launch = deferred();
    const { manager, records } = fixture({
      beforeResolveLaunch: () => launch.promise,
    });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    const [first, second] = await Promise.all([
      manager.start(worktreeId),
      manager.start(worktreeId),
    ]);
    expect(first.runtimeId).toBe(second.runtimeId);
    expect(first.state).toBe("starting");

    const owner = transport();
    const observer = transport();
    const detachOwner = await manager.attach(
      worktreeId,
      "owner",
      0,
      owner.socket,
    );
    await manager.attach(worktreeId, "observer", 0, observer.socket);
    expect(owner.frames.find((frame) => frame.type === "hello")).toMatchObject({
      inputOwner: true,
      runtime: { state: "starting", launchError: null },
    });
    expect(
      observer.frames.find((frame) => frame.type === "hello"),
    ).toMatchObject({ inputOwner: false });
    expect(() => manager.input(worktreeId, "observer", "blocked")).toThrow(
      TerminalManagerError,
    );

    launch.resolve();
    await waitFor(() => manager.get(worktreeId).state === "running");
    records.get(worktreeId)!.lifecycle = "removing";
    await expect(manager.start(worktreeId)).rejects.toMatchObject({
      code: "WORKTREE_NOT_READY",
    });
    records.get(worktreeId)!.lifecycle = "ready";

    manager.input(worktreeId, "owner", "echo-value");
    await waitFor(() =>
      owner.frames.some(
        (frame) => frame.type === "output" && frame.data.includes("echo-value"),
      ),
    );
    detachOwner();
    expect(manager.get(worktreeId).state).toBe("running");

    const stopped = await manager.stop(worktreeId);
    expect(stopped.state).toBe("stopped");
    await manager.shutdown();
  });

  it("does not reserve a runtime for an already closed attachment", async () => {
    const { manager } = fixture();
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    const controller = new AbortController();
    controller.abort();

    await expect(
      manager.attach(
        worktreeId,
        "closed",
        0,
        transport().socket,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.get(worktreeId)).toMatchObject({
      runtimeId: null,
      state: "stopped",
    });
    await manager.shutdown();
  });

  it("does not reserve a replacement when a queued attachment closes", async () => {
    const { manager } = fixture();
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    const { running } = await startRunning(manager, worktreeId);
    const stopping = manager.stop(worktreeId);
    const controller = new AbortController();
    const attaching = manager.attach(
      worktreeId,
      "closed-while-queued",
      0,
      transport().socket,
      controller.signal,
    );
    controller.abort();

    await expect(stopping).resolves.toMatchObject({ state: "stopped" });
    await expect(attaching).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.get(worktreeId)).toMatchObject({
      runtimeId: running.runtimeId,
      state: "stopped",
    });
    await manager.shutdown();
  });

  it("atomically reserves a starting runtime for the first attached client", async () => {
    const launch = deferred();
    const { manager } = fixture({
      beforeResolveLaunch: () => launch.promise,
    });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    const client = transport();

    await manager.attach(worktreeId, "owner", 0, client.socket);
    const hello = client.frames.find((frame) => frame.type === "hello");
    expect(hello).toMatchObject({
      runtime: { state: "starting", launchError: null },
      inputOwner: true,
    });
    const concurrent = await manager.start(worktreeId);
    expect(concurrent.runtimeId).toBe(
      hello?.type === "hello" ? hello.runtime.runtimeId : undefined,
    );

    launch.resolve();
    await waitFor(() => manager.get(worktreeId).state === "running");
    await manager.shutdown();
  });

  it("retains a sanitized asynchronous launch failure for attached clients", async () => {
    const launch = deferred();
    const { manager } = fixture({
      beforeResolveLaunch: () => launch.promise,
      launchFailure: new Error("private launch detail"),
    });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    await expect(manager.start(worktreeId)).resolves.toMatchObject({
      state: "starting",
      launchError: null,
    });
    const client = transport();
    await manager.attach(worktreeId, "owner", 0, client.socket);

    launch.resolve();
    await waitFor(() => manager.get(worktreeId).state === "crashed");
    expect(manager.get(worktreeId).launchError).toEqual({
      code: "PTY_START_FAILED",
      message: "Pi could not be started in the managed worktree",
    });
    expect(
      client.frames.find(
        (frame) =>
          frame.type === "runtime" && frame.runtime.state === "crashed",
      ),
    ).toMatchObject({
      runtime: {
        launchError: {
          code: "PTY_START_FAILED",
          message: "Pi could not be started in the managed worktree",
        },
      },
    });
    expect(JSON.stringify(client.frames)).not.toContain(
      "private launch detail",
    );
    await manager.shutdown();
  });

  it("cancels launch preparation without a late running transition", async () => {
    const { manager } = fixture({
      beforeResolveLaunch: (signal) =>
        new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    await expect(manager.start(worktreeId)).resolves.toMatchObject({
      state: "starting",
    });

    await expect(manager.stop(worktreeId)).resolves.toMatchObject({
      state: "stopped",
      launchError: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manager.get(worktreeId).state).toBe("stopped");
    await manager.shutdown();
  });

  it("verifies the PTY leader and cleans captured descendants after the leader exits", async () => {
    const { manager } = fixture({ childTree: true });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    const { running: firstRuntime } = await startRunning(manager, worktreeId);
    const client = transport();
    await manager.attach(worktreeId, "owner", 0, client.socket);
    const output = () =>
      client.frames
        .filter((frame) => frame.type === "output")
        .map((frame) => frame.data)
        .join("");
    await waitFor(() => output().includes("FAKE_PI_TREE"));
    const ready = output().match(/FAKE_PI_READY (\{[^\r\n]+\})/);
    expect(ready).toBeTruthy();
    const identity = JSON.parse(ready![1]!) as {
      pid: number;
      processGroup: number;
    };
    expect(identity.processGroup).toBe(identity.pid);
    const tree = output().match(/FAKE_PI_TREE (\d+) (\d+)/);
    expect(tree).toBeTruthy();
    const descendants = [Number(tree![1]), Number(tree![2])];
    await new Promise((resolve) => setTimeout(resolve, 400));

    manager.input(worktreeId, "owner", "__EXIT__");
    await waitFor(() => manager.get(worktreeId).state === "stopped");
    expect(descendants.some((pid) => existsSync(`/proc/${pid}`))).toBe(true);
    const { starting: replacement } = await startRunning(manager, worktreeId);
    expect(replacement.runtimeId).not.toBe(firstRuntime.runtimeId);
    expect(replacement.state).toBe("starting");
    await waitFor(() =>
      descendants.every((pid) => !existsSync(`/proc/${pid}`)),
    );
    await manager.stop(worktreeId);
    await manager.shutdown();
  });

  it("captures and cleans a descendant orphaned between scans", async () => {
    const { manager } = fixture({ orphan: true });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    await startRunning(manager, worktreeId);
    const client = transport();
    await manager.attach(worktreeId, "owner", 0, client.socket);
    const output = () =>
      client.frames
        .filter((frame) => frame.type === "output")
        .map((frame) => frame.data)
        .join("");
    await waitFor(() => /FAKE_PI_ORPHAN \d+/.test(output()));
    const orphanPid = Number(output().match(/FAKE_PI_ORPHAN (\d+)/)![1]);

    try {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      manager.input(worktreeId, "owner", "__EXIT__");
      await waitFor(() => manager.get(worktreeId).state === "stopped");
      expect(existsSync(`/proc/${orphanPid}`)).toBe(true);
      await manager.stop(worktreeId);
      await waitFor(() => !existsSync(`/proc/${orphanPid}`));
    } finally {
      try {
        process.kill(orphanPid, "SIGKILL");
      } catch {
        // The manager already cleaned the orphan.
      }
      await manager.shutdown();
    }
  });

  it("stays running while short-lived descendants churn", async () => {
    const { manager } = fixture({ childChurn: true });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    await startRunning(manager, worktreeId);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(manager.get(worktreeId).state).toBe("running");
    await manager.shutdown();
  });

  it("tracks foreground shell commands and keeps the shell alive without clients", async () => {
    const { manager, records } = fixture({ shell: true });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    await startRunning(manager, worktreeId);
    const client = transport();
    const detach = await manager.attach(worktreeId, "owner", 0, client.socket);
    const output = () =>
      client.frames
        .filter((frame) => frame.type === "output")
        .map((frame) => frame.data)
        .join("");

    manager.input(worktreeId, "owner", "pwd\n");
    await waitFor(() => output().includes(records.get(worktreeId)!.path));
    manager.input(worktreeId, "owner", "sleep 30 & echo SHELL_BG:$!\n");
    await waitFor(() => /SHELL_BG:\d+/.test(output()));
    const backgroundPid = Number(output().match(/SHELL_BG:(\d+)/)![1]);
    expect(existsSync(`/proc/${backgroundPid}`)).toBe(true);
    expect(manager.activities()[0]?.foregroundCommandActive).toBe(false);

    manager.input(worktreeId, "owner", "sleep 1\n");
    await waitFor(
      () => manager.activities()[0]?.foregroundCommandActive === true,
    );
    detach();
    expect(manager.get(worktreeId).state).toBe("running");
    await waitFor(
      () => manager.activities()[0]?.foregroundCommandActive === false,
      3_000,
    );
    await manager.shutdown();
    await waitFor(() => !existsSync(`/proc/${backgroundPid}`));
  });

  it("keeps terminal startup and shutdown fail-open when status observers throw", async () => {
    const { manager } = fixture({ statusFails: true });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    await startRunning(manager, worktreeId);
    await expect(manager.stop(worktreeId)).resolves.toMatchObject({
      state: "stopped",
    });
    await manager.shutdown();
  });

  it("retains crashes and makes restart retries idempotent", async () => {
    const { manager } = fixture();
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    await startRunning(manager, worktreeId);
    const client = transport();
    await manager.attach(worktreeId, "owner", 0, client.socket);
    manager.input(worktreeId, "owner", "__CRASH__");
    await waitFor(() => manager.get(worktreeId).state === "crashed");
    expect(manager.get(worktreeId).exitCode).toBe(7);

    const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const crashedRuntimeId = manager.get(worktreeId).runtimeId;
    const restarted = await manager.restart(worktreeId, key, crashedRuntimeId);
    const replay = await manager.restart(worktreeId, key, crashedRuntimeId);
    expect(replay).toEqual(restarted);
    expect(restarted.restarted).toBe(true);
    expect(restarted.runtime.state).toBe("starting");
    await waitFor(() => manager.get(worktreeId).state === "running");

    const stale = await manager.restart(
      worktreeId,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      crashedRuntimeId,
    );
    expect(stale.restarted).toBe(false);
    expect(stale.runtime.runtimeId).toBe(restarted.runtime.runtimeId);
    expect(() =>
      manager.restart("22222222-2222-4222-8222-222222222222", key, null),
    ).toThrowError(/different input/);
    await manager.shutdown();
  });
});
