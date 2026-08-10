import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeDto } from "@pi-dash/contracts";
import {
  createWorkspaceEnvironmentService,
  WorkspaceEnvironmentError,
  type LiveWorkspaceRuntime,
} from "../src/workspaces/workspace-environment.js";
import type {
  WorkspaceRecord,
  WorkspaceRepository,
} from "../src/workspaces/workspace-repository.js";

const roots: string[] = [];
const workspaceId = "11111111-1111-4111-8111-111111111111";
const worktreeId = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-environment-"));
  roots.push(root);
  const repositoryPath = join(root, "repository");
  const record: WorkspaceRecord = {
    id: workspaceId,
    name: "Environment",
    slug: "environment",
    repositoryPath,
    gitCommonDir: join(repositoryPath, ".git"),
    privateEnvironmentPath: null,
    repositoryHealth: "healthy",
    currentBranch: "main",
    headCommit: "a".repeat(40),
    checkedAt: "2026-01-01T00:00:00.000Z",
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let liveRuntimes: LiveWorkspaceRuntime[] = [];
  const changed: string[] = [];
  const repository = {
    list: () => [record],
    get: (id: string) => (id === workspaceId ? record : undefined),
    updatePrivateEnvironmentPath: (
      id: string,
      path: string | null,
      updatedAt: string,
    ) => {
      if (id !== workspaceId) return undefined;
      record.privateEnvironmentPath = path;
      record.updatedAt = updatedAt;
      return { ...record };
    },
  } as unknown as WorkspaceRepository;
  const service = createWorkspaceEnvironmentService({
    repository,
    liveRuntimes: () => liveRuntimes,
    onWorkspaceChanged: (id) => changed.push(id),
    inherited: { SHARED: "same" },
    refreshIntervalMs: 60_000,
  });
  return {
    root,
    repositoryPath,
    record,
    service,
    changed,
    setLiveRuntimes(value: LiveWorkspaceRuntime[]) {
      liveRuntimes = value;
    },
  };
}

function runtime(runtimeId: string): RuntimeDto {
  return {
    worktreeId,
    runtimeId,
    state: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    exitedAt: null,
    exitCode: null,
    signal: null,
    launchError: null,
    attachedClients: 0,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace environment", () => {
  it("loads effective values, detects changes, and clears them after restart", () => {
    const target = fixture();
    mkdirSync(target.repositoryPath, { recursive: true });
    writeFileSync(
      join(target.repositoryPath, ".env"),
      'SHARED=repository\nQUOTED="two words"\n',
    );
    const privateFile = join(target.root, "private.env");
    writeFileSync(privateFile, "SHARED=private\nSECRET=secret-marker\n");
    target.service.updatePrivateFile(workspaceId, privateFile);
    target.service.start();

    const firstRuntimeId = "33333333-3333-4333-8333-333333333333";
    target.setLiveRuntimes([
      { workspaceId, kind: "shell", runtime: runtime(firstRuntimeId) },
    ]);
    expect(
      target.service.prepareRuntime({
        workspaceId,
        worktreeId,
        runtimeId: firstRuntimeId,
        kind: "shell",
      }),
    ).toEqual({
      SHARED: "private",
      QUOTED: "two words",
      SECRET: "secret-marker",
    });
    expect(JSON.stringify(target.service.get(workspaceId))).not.toContain(
      "secret-marker",
    );

    writeFileSync(privateFile, "SHARED=changed\nSECRET=secret-marker\n");
    target.service.get(workspaceId);
    expect(target.service.changes()).toEqual([
      {
        workspaceId,
        affectedRuntimes: [
          { worktreeId, runtimeId: firstRuntimeId, kind: "shell" },
        ],
      },
    ]);

    const secondRuntimeId = "44444444-4444-4444-8444-444444444444";
    target.setLiveRuntimes([
      { workspaceId, kind: "shell", runtime: runtime(secondRuntimeId) },
    ]);
    expect(
      target.service.prepareRuntime({
        workspaceId,
        worktreeId,
        runtimeId: secondRuntimeId,
        kind: "shell",
      }).SHARED,
    ).toBe("changed");
    expect(target.service.changes()).toEqual([]);
    target.service.close();
  });

  it("detects source edits through background polling", async () => {
    vi.useFakeTimers();
    const target = fixture();
    try {
      mkdirSync(target.repositoryPath, { recursive: true });
      const repositoryFile = join(target.repositoryPath, ".env");
      writeFileSync(repositoryFile, "VALUE=before\n");
      target.service.start();
      const runtimeId = "33333333-3333-4333-8333-333333333333";
      target.setLiveRuntimes([
        { workspaceId, kind: "pi", runtime: runtime(runtimeId) },
      ]);
      target.service.prepareRuntime({
        workspaceId,
        worktreeId,
        runtimeId,
        kind: "pi",
      });

      writeFileSync(repositoryFile, "VALUE=after\n");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(target.service.changes()).toEqual([
        {
          workspaceId,
          affectedRuntimes: [{ worktreeId, runtimeId, kind: "pi" }],
        },
      ]);
    } finally {
      target.service.close();
      vi.useRealTimers();
    }
  });

  it("does not require restart when source edits leave the injected environment unchanged", () => {
    const target = fixture();
    mkdirSync(target.repositoryPath, { recursive: true });
    const repositoryFile = join(target.repositoryPath, ".env");
    writeFileSync(repositoryFile, "SHARED=same\n");
    target.service.start();
    const runtimeId = "33333333-3333-4333-8333-333333333333";
    target.setLiveRuntimes([
      { workspaceId, kind: "pi", runtime: runtime(runtimeId) },
    ]);
    target.service.prepareRuntime({
      workspaceId,
      worktreeId,
      runtimeId,
      kind: "pi",
    });

    rmSync(repositoryFile);
    target.service.get(workspaceId);
    expect(target.service.changes()).toEqual([]);

    writeFileSync(repositoryFile, "TERM=not-allowed\n");
    expect(target.service.get(workspaceId)).toMatchObject({ status: "error" });
    target.service.close();
  });

  it("reports no automatic source when .env is absent", () => {
    const target = fixture();
    mkdirSync(target.repositoryPath, { recursive: true });
    expect(target.service.get(workspaceId)).toMatchObject({
      repositoryFile: { present: false },
      status: "empty",
      variableCount: 0,
      error: null,
    });
  });

  it("accepts an environment source writable by other users", () => {
    const target = fixture();
    mkdirSync(target.repositoryPath, { recursive: true });
    const repositoryFile = join(target.repositoryPath, ".env");
    writeFileSync(repositoryFile, "SHARED=world-writable\n");
    chmodSync(repositoryFile, 0o666);

    expect(target.service.get(workspaceId)).toMatchObject({
      status: "ready",
      variableCount: 1,
      error: null,
    });
  });

  it("does not require the environment source to match the daemon user", () => {
    const target = fixture();
    mkdirSync(target.repositoryPath, { recursive: true });
    writeFileSync(join(target.repositoryPath, ".env"), "SHARED=accepted\n");
    const daemonUid = process.getuid();
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(daemonUid + 1);

    try {
      expect(target.service.get(workspaceId)).toMatchObject({
        status: "ready",
        variableCount: 1,
        error: null,
      });
    } finally {
      getuid.mockRestore();
    }
  });

  it("fails closed for malformed, reserved, and symlinked sources", () => {
    const malformed = fixture();
    mkdirSync(malformed.repositoryPath, { recursive: true });
    writeFileSync(
      join(malformed.repositoryPath, ".env"),
      "not an assignment\n",
    );
    expect(malformed.service.get(workspaceId)).toMatchObject({
      status: "error",
    });
    expect(() =>
      malformed.service.prepareRuntime({
        workspaceId,
        worktreeId,
        runtimeId: "33333333-3333-4333-8333-333333333333",
        kind: "pi",
      }),
    ).toThrow(WorkspaceEnvironmentError);

    const reserved = join(malformed.root, "reserved.env");
    writeFileSync(reserved, "PI_DASH_STATUS_TOKEN=forbidden\n");
    expect(() =>
      malformed.service.updatePrivateFile(workspaceId, reserved),
    ).toThrow(/reserved PI_DASH/);

    const linked = fixture();
    mkdirSync(linked.repositoryPath, { recursive: true });
    const source = join(linked.root, "source.env");
    writeFileSync(source, "SAFE=value\n");
    symlinkSync(source, join(linked.repositoryPath, ".env"));
    expect(linked.service.get(workspaceId)).toMatchObject({ status: "error" });
  });
});
