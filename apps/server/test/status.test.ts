import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StatusExtensionFrame } from "@pi-dash/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseService } from "../src/database.js";
import { createStatusRepository } from "../src/status/status-repository.js";
import {
  createStatusService,
  StatusProcessingError,
} from "../src/status/status-service.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);
const roots: string[] = [];
const workspaceId = "11111111-1111-4111-8111-111111111111";
const worktreeId = "22222222-2222-4222-8222-222222222222";
const secondWorktreeId = "99999999-9999-4999-8999-999999999999";
const runtimeId = "33333333-3333-4333-8333-333333333333";
const epoch = "44444444-4444-4444-8444-444444444444";
const secondEpoch = "55555555-5555-4555-8555-555555555555";
const firstInteraction = "66666666-6666-4666-8666-666666666666";
const secondInteraction = "77777777-7777-4777-8777-777777777777";
const completionId = "88888888-8888-4888-8888-888888888888";
const token = "t".repeat(43);

async function fixture(handshakeTimeoutMs = 10_000): Promise<{
  database: DatabaseService;
  repository: ReturnType<typeof createStatusRepository>;
  service: ReturnType<typeof createStatusService>;
}> {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-status-"));
  roots.push(root);
  const database = await openDatabase({
    path: join(root, "database.sqlite"),
    migrationsDirectory,
  });
  const timestamp = "2026-01-01T00:00:00.000Z";
  database.sqlite
    .prepare(
      `INSERT INTO workspaces (
        id, name, slug, repository_path, git_common_dir, created_at, updated_at
      ) VALUES (?, 'Workspace', 'workspace', '/repo', '/repo/.git', ?, ?)`,
    )
    .run(workspaceId, timestamp, timestamp);
  database.sqlite
    .prepare(
      `INSERT INTO worktrees (
        id, workspace_id, name, slug, path, branch_ref, base_ref, base_commit,
        lifecycle, health, created_at, updated_at
      ) VALUES (?, ?, 'Feature', 'feature', '/managed/feature',
        'refs/heads/pi-dash/feature', 'HEAD', ?, 'ready', 'healthy', ?, ?)`,
    )
    .run(worktreeId, workspaceId, "a".repeat(40), timestamp, timestamp);
  const repository = createStatusRepository(database.sqlite);
  const service = createStatusService({
    repository,
    now: () => new Date("2026-01-01T00:00:10.000Z"),
    handshakeTimeoutMs,
  });
  service.registerRuntime(worktreeId, runtimeId, token);
  return { database, repository, service };
}

function event(
  seq: number,
  name: "session_start" | "session_shutdown" | "agent_start" | "agent_settled",
  extensionInstanceId = epoch,
): StatusExtensionFrame {
  const base = {
    v: 1 as const,
    kind: "event" as const,
    runtimeId,
    worktreeId,
    token,
    extensionInstanceId,
    seq,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  return name === "agent_settled"
    ? { ...base, event: name, completionId }
    : { ...base, event: name };
}

function waitEvent(
  seq: number,
  name: "blocking_wait_start" | "blocking_wait_end",
  interactionId: string,
  extensionInstanceId = epoch,
): StatusExtensionFrame {
  return {
    ...event(seq, "agent_start", extensionInstanceId),
    event: name,
    interactionId,
    reason: "ask_user",
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("workflow status", () => {
  it("reduces lifecycle and overlapping exact blocking interactions", async () => {
    const { database, service } = await fixture();
    expect(service.process(event(1, "session_start")).integration).toBe(
      "connected",
    );
    expect(service.process(event(2, "agent_start")).state).toBe("working");
    expect(
      service.process(waitEvent(3, "blocking_wait_start", firstInteraction))
        .state,
    ).toBe("blocked");
    const blockedRevision = service.get(worktreeId)!.revision;
    expect(
      service.process(waitEvent(4, "blocking_wait_start", secondInteraction))
        .revision,
    ).toBe(blockedRevision);
    expect(
      service.process(waitEvent(5, "blocking_wait_end", firstInteraction))
        .state,
    ).toBe("blocked");
    expect(
      service.process(waitEvent(6, "blocking_wait_end", secondInteraction))
        .state,
    ).toBe("working");
    const done = service.process(event(7, "agent_settled"));
    expect(done.state).toBe("done");
    const acknowledged = service.acknowledge(worktreeId, done.revision);
    expect(acknowledged).toMatchObject({
      state: "idle",
      reason: "acknowledged",
      acknowledgedAt: "2026-01-01T00:00:10.000Z",
    });
    expect(service.process(event(8, "agent_settled"))).toEqual(acknowledged);
    database.close();
  });

  it("rejects wrong tokens, duplicate sequences, and frames from retired epochs", async () => {
    const { database, service } = await fixture();
    service.process(event(1, "session_start"));
    expect(() => service.process(event(1, "agent_start"))).toThrow(
      StatusProcessingError,
    );
    expect(() =>
      service.process({ ...event(2, "agent_start"), token: "x".repeat(43) }),
    ).toThrow("STATUS_AUTH_FAILED");
    service.process(event(1, "session_start", secondEpoch));
    expect(() => service.process(event(2, "agent_start", epoch))).toThrow(
      "STATUS_EVENT_INVALID",
    );
    expect(() => service.process(event(1, "session_start", epoch))).toThrow(
      "STATUS_EVENT_INVALID",
    );
    database.close();
  });

  it("preserves unread done across snapshots and resets only active state on runtime exit/startup", async () => {
    const { database, repository, service } = await fixture();
    service.process(event(1, "session_start"));
    service.process(event(2, "agent_start"));
    const done = service.process(event(3, "agent_settled"));
    const snapshot: StatusExtensionFrame = {
      v: 1,
      kind: "snapshot",
      runtimeId,
      worktreeId,
      token,
      extensionInstanceId: epoch,
      seq: 4,
      timestamp: "2026-01-01T00:00:00.000Z",
      agentActive: false,
      blockingInteractions: [],
    };
    expect(service.process(snapshot)).toEqual(done);
    service.resetRuntime(worktreeId, runtimeId);
    expect(service.get(worktreeId)!.state).toBe("done");

    repository.transition(
      worktreeId,
      "working",
      "agent",
      "2026-01-01T00:00:11.000Z",
    );
    const reset = repository.resetActive("2026-01-01T00:00:12.000Z");
    expect(reset[0]).toMatchObject({ state: "idle", reason: "runtime_reset" });
    database.close();
  });

  it("rolls workspace activity up with active work ahead of unread completions", async () => {
    const { database, repository, service } = await fixture();
    const timestamp = "2026-01-01T00:00:00.000Z";
    database.sqlite
      .prepare(
        `INSERT INTO worktrees (
          id, workspace_id, name, slug, path, branch_ref, base_ref, base_commit,
          lifecycle, health, created_at, updated_at
        ) VALUES (?, ?, 'Second', 'second', '/managed/second',
          'refs/heads/pi-dash/second', 'HEAD', ?, 'ready', 'healthy', ?, ?)`,
      )
      .run(secondWorktreeId, workspaceId, "b".repeat(40), timestamp, timestamp);

    repository.transition(worktreeId, "done", "settled", timestamp);
    repository.transition(secondWorktreeId, "working", "agent", timestamp);
    expect(service.workspaceAttention()[0]).toMatchObject({
      state: "working",
      integration: "disconnected",
    });

    repository.setIntegration(worktreeId, "connected");
    repository.setIntegration(secondWorktreeId, "connected");
    expect(service.workspaceAttention()).toEqual([
      {
        workspaceId,
        state: "working",
        count: 2,
        integration: "connected",
      },
    ]);

    repository.transition(secondWorktreeId, "blocked", "ask_user", timestamp);
    expect(service.workspaceAttention()[0]?.state).toBe("blocked");

    repository.transition(secondWorktreeId, "idle", "acknowledged", timestamp);
    expect(service.workspaceAttention()[0]).toMatchObject({
      state: "done",
      count: 1,
    });

    repository.setIntegration(worktreeId, "unsupported");
    repository.transition(secondWorktreeId, "working", "agent", timestamp);
    expect(service.workspaceAttention()[0]).toMatchObject({
      state: "working",
      integration: "unsupported",
    });
    database.close();
  });

  it("rejects inconsistent blocking snapshots", async () => {
    const { database, service } = await fixture();
    service.process(event(1, "session_start"));
    expect(() =>
      service.process({
        v: 1,
        kind: "snapshot",
        runtimeId,
        worktreeId,
        token,
        extensionInstanceId: epoch,
        seq: 2,
        timestamp: "2026-01-01T00:00:00.000Z",
        agentActive: false,
        blockingInteractions: [{ id: firstInteraction, reason: "ask_user" }],
      }),
    ).toThrow("STATUS_EVENT_INVALID");
    database.close();
  });

  it("marks a runtime unsupported when no compatible extension handshakes", async () => {
    const { database, service } = await fixture(5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(service.get(worktreeId)?.integration).toBe("unsupported");
    database.close();
  });

  it("uses revision compare-and-set acknowledgement", async () => {
    const { database, service } = await fixture();
    service.process(event(1, "session_start"));
    service.process(event(2, "agent_start"));
    const done = service.process(event(3, "agent_settled"));
    expect(() => service.acknowledge(worktreeId, done.revision - 1)).toThrow(
      "STATUS_EVENT_INVALID",
    );
    expect(service.get(worktreeId)!.state).toBe("done");
    database.close();
  });
});
