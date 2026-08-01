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

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for terminal event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fixture(options: { childTree?: boolean } = {}) {
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
  const claims = new Set<string>();
  const lifecycle: WorktreeLifecycleCoordinator = {
    claimRemoval: () => undefined,
    restoreReady: () => undefined,
    claimTerminalStart(id) {
      const record = records.get(id);
      if (!record || record.lifecycle !== "ready" || claims.has(id))
        return undefined;
      claims.add(id);
      return record as never;
    },
    releaseTerminalStart(id) {
      claims.delete(id);
    },
    canStartTerminal(id) {
      return records.get(id)?.lifecycle === "ready" && !claims.has(id);
    },
  };
  const manager = createTerminalManager({
    lifecycle,
    pi: createPiResolver({
      executable: fakePi,
      minimumVersion: "0.83.0",
      extensionPath,
    }),
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
    inheritedEnv: {
      ...process.env,
      PI_DASH_BOOTSTRAP_TOKEN: "must-not-leak",
      ...(options.childTree ? { FAKE_PI_CHILD_TREE: "1" } : {}),
    },
    runtimeDirectory: cwd,
    initialCols: 80,
    initialRows: 24,
    outputBufferBytes: 64 * 1024,
    maxSocketBufferedBytes: 1024 * 1024,
    stopGraceMs: 1_000,
  });
  return { manager, records };
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
  it("collapses starts, preserves the PTY without clients, and enforces one input owner", async () => {
    const { manager, records } = fixture();
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    const [first, second] = await Promise.all([
      manager.start(worktreeId),
      manager.start(worktreeId),
    ]);
    expect(first.runtimeId).toBe(second.runtimeId);
    expect(first.state).toBe("running");
    records.get(worktreeId)!.lifecycle = "removing";
    await expect(manager.start(worktreeId)).rejects.toMatchObject({
      code: "WORKTREE_NOT_READY",
    });
    records.get(worktreeId)!.lifecycle = "ready";

    const owner = transport();
    const observer = transport();
    const detachOwner = manager.attach(worktreeId, "owner", 0, owner.socket);
    manager.attach(worktreeId, "observer", 0, observer.socket);
    expect(owner.frames.find((frame) => frame.type === "hello")).toMatchObject({
      inputOwner: true,
    });
    expect(
      observer.frames.find((frame) => frame.type === "hello"),
    ).toMatchObject({ inputOwner: false });
    expect(() => manager.input(worktreeId, "observer", "blocked")).toThrow(
      TerminalManagerError,
    );

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

  it("verifies the PTY leader and cleans captured descendants after the leader exits", async () => {
    const { manager } = fixture({ childTree: true });
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    const firstRuntime = await manager.start(worktreeId);
    const client = transport();
    manager.attach(worktreeId, "owner", 0, client.socket);
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
    const replacement = await manager.start(worktreeId);
    expect(replacement.runtimeId).not.toBe(firstRuntime.runtimeId);
    expect(replacement.state).toBe("running");
    await waitFor(() =>
      descendants.every((pid) => !existsSync(`/proc/${pid}`)),
    );
    await manager.stop(worktreeId);
    await manager.shutdown();
  });

  it("retains crashes and makes restart retries idempotent", async () => {
    const { manager } = fixture();
    const worktreeId = "11111111-1111-4111-8111-111111111111";
    await manager.start(worktreeId);
    const client = transport();
    manager.attach(worktreeId, "owner", 0, client.socket);
    manager.input(worktreeId, "owner", "__CRASH__");
    await waitFor(() => manager.get(worktreeId).state === "crashed");
    expect(manager.get(worktreeId).exitCode).toBe(7);

    const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const restarted = await manager.restart(worktreeId, key);
    const replay = await manager.restart(worktreeId, key);
    expect(replay).toEqual(restarted);
    expect(restarted.runtime.state).toBe("running");
    expect(() =>
      manager.restart("22222222-2222-4222-8222-222222222222", key),
    ).toThrowError(/different input/);
    await manager.shutdown();
  });
});
