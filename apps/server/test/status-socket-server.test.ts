import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { createStatusRepository } from "../src/status/status-repository.js";
import { createStatusService } from "../src/status/status-service.js";
import { createStatusSocketServer } from "../src/status/status-socket-server.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);
const roots: string[] = [];

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for status");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("status socket server", () => {
  it("authenticates bounded split LF frames and rejects duplicate ordering", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-status-socket-"));
    roots.push(root);
    const database = await openDatabase({
      path: join(root, "database.sqlite"),
      migrationsDirectory,
    });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const worktreeId = "22222222-2222-4222-8222-222222222222";
    const runtimeId = "33333333-3333-4333-8333-333333333333";
    const extensionInstanceId = "44444444-4444-4444-8444-444444444444";
    const token = "t".repeat(43);
    database.sqlite
      .prepare(
        "INSERT INTO workspaces (id, name, slug, repository_path, git_common_dir, created_at, updated_at) VALUES (?, 'W', 'w', '/r', '/r/.git', ?, ?)",
      )
      .run(workspaceId, timestamp, timestamp);
    database.sqlite
      .prepare(
        `INSERT INTO worktrees (
          id, workspace_id, name, slug, path, branch_ref, base_ref, base_commit,
          lifecycle, health, created_at, updated_at
        ) VALUES (?, ?, 'T', 't', '/t', 'refs/heads/t', 'HEAD', ?, 'ready', 'healthy', ?, ?)`,
      )
      .run(worktreeId, workspaceId, "a".repeat(40), timestamp, timestamp);
    const statuses = createStatusService({
      repository: createStatusRepository(database.sqlite),
      now: () => new Date(timestamp),
    });
    statuses.registerRuntime(worktreeId, runtimeId, token);
    const socketPath = join(root, "status.sock");
    const statusSocket = createStatusSocketServer({
      path: socketPath,
      statuses,
      now: () => new Date(timestamp),
      maxConnections: 1,
      handshakeTimeoutMs: 20,
    });
    await statusSocket.start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const base = {
      v: 1,
      kind: "event",
      runtimeId,
      worktreeId,
      token,
      extensionInstanceId,
      timestamp,
    };
    const handshake = `${JSON.stringify({ ...base, seq: 1, event: "session_start" })}\n`;
    socket.write(handshake.slice(0, 13));
    socket.write(handshake.slice(13));
    socket.write(
      `${JSON.stringify({ ...base, seq: 2, event: "agent_start" })}\n`,
    );
    await waitFor(() => statuses.get(worktreeId)?.state === "working");
    expect(statuses.get(worktreeId)).toMatchObject({
      state: "working",
      integration: "connected",
    });

    const excess = createConnection(socketPath);
    excess.on("error", () => undefined);
    await new Promise<void>((resolve) => excess.once("close", resolve));

    socket.write(
      `${JSON.stringify({
        ...base,
        seq: 2,
        event: "agent_settled",
        completionId: "55555555-5555-4555-8555-555555555555",
      })}\n`,
    );
    await new Promise<void>((resolve) => socket.once("close", resolve));
    expect(statuses.get(worktreeId)?.state).toBe("working");
    await waitFor(
      () => statuses.get(worktreeId)?.integration === "disconnected",
    );

    const idle = createConnection(socketPath);
    idle.on("error", () => undefined);
    await new Promise<void>((resolve) => idle.once("close", resolve));
    await statusSocket.close();
    database.close();
  });
});
