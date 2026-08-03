import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepository } from "../../../tests/fixtures/git-repository.js";
import { buildHttpServer, type HttpServer } from "../src/app.js";
import { createAuthService, SESSION_COOKIE } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseService } from "../src/database.js";
import { createGitInspector } from "../src/git/git-inspector.js";
import { createGitWorkspaceSynchronizer } from "../src/git/git-workspace-sync.js";
import type { NativeDirectoryDialogService } from "../src/platform/native-directory-dialog.js";
import { createOriginPolicy } from "../src/security.js";
import { createWorkspaceRepository } from "../src/workspaces/workspace-repository.js";
import { createWorkspaceService } from "../src/workspaces/workspace-service.js";
import { createGitMutationLock } from "../src/worktrees/git-mutation-lock.js";
import { createStatusTestServices } from "./status-stub.js";
import { createUnavailableTerminalManager } from "./terminal-manager-stub.js";
import { createUnavailableWorktreeService } from "./worktree-service-stub.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);
const resources: Array<{
  root: string;
  app: HttpServer;
  database: DatabaseService;
}> = [];

function baseHeaders(extra: Record<string, string> = {}) {
  return { host: "127.0.0.1:4317", ...extra };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-workspace-api-"));
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 4317,
    piExecutable: "pi",
    piMinimumVersion: "0.83.0",
    terminalInitialCols: 100,
    terminalInitialRows: 30,
    terminalOutputBufferBytes: 1024 * 1024,
    terminalMaxFrameBytes: 64 * 1024,
    terminalMaxSocketBufferedBytes: 4 * 1024 * 1024,
    terminalStopGraceMs: 2_000,
    terminalCacheSize: 3,
    nativeDialog: "auto",
    logLevel: "silent",
    openBrowser: false,
    mode: "test",
  };
  const database = await openDatabase({
    path: join(root, "database.sqlite"),
    migrationsDirectory,
  });
  const policy = createOriginPolicy(config);
  const auth = createAuthService({ policy });
  let selectedPath = "";
  const dialogs: NativeDirectoryDialogService = {
    async probe() {
      return { available: true, adapter: "zenity" };
    },
    async chooseDirectory() {
      return { cancelled: false, path: selectedPath, adapter: "zenity" };
    },
    close() {},
  };
  const workspaces = createWorkspaceService({
    repository: createWorkspaceRepository(database.sqlite),
    git: await createGitInspector(),
    syncer: await createGitWorkspaceSynchronizer(),
    lock: createGitMutationLock({ root: join(root, "locks") }),
  });
  const status = createStatusTestServices(database.sqlite);
  const app = await buildHttpServer({
    config,
    database,
    auth,
    policy,
    logger: pino({ level: "silent" }),
    staticDirectory: join(root, "unused"),
    dialogs,
    workspaces,
    worktrees: createUnavailableWorktreeService(),
    terminals: createUnavailableTerminalManager(),
    statuses: status.statuses,
    events: status.events,
    capabilities: {
      git: true,
      pi: false,
      nativeDirectoryDialog: true,
      pty: false,
    },
  });
  resources.push({ root, app, database });

  const bootstrap = await app.inject({
    method: "GET",
    url: `/auth/bootstrap?token=${encodeURIComponent(auth.bootstrapToken)}`,
    headers: baseHeaders(),
  });
  const cookie = bootstrap.cookies.find(
    (candidate) => candidate.name === SESSION_COOKIE,
  )!;
  const cookieHeader = `${SESSION_COOKIE}=${cookie.value}`;
  const session = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: baseHeaders({ cookie: cookieHeader }),
  });
  const authHeaders = baseHeaders({
    cookie: cookieHeader,
    origin: "http://127.0.0.1:4317",
    "content-type": "application/json",
    "x-csrf-token": session.json().csrfToken as string,
  });
  return {
    root,
    app,
    authHeaders,
    setDialogPath(path: string) {
      selectedPath = path;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ root, app, database }) => {
      await app.close();
      database.close();
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("workspace API", () => {
  it("selects, previews, registers, lists, renames, refreshes, and removes a workspace", async () => {
    const { root, app, authHeaders, setDialogPath } = await fixture();
    const repository = createGitRepository(root, "api-project");
    setDialogPath(repository);

    const selection = await app.inject({
      method: "POST",
      url: "/api/v1/dialogs/workspace-directory",
      headers: authHeaders,
      payload: {},
    });
    expect(selection.statusCode).toBe(200);
    expect(selection.json()).toEqual({
      cancelled: false,
      path: repository,
      adapter: "zenity",
    });

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/inspect",
      headers: authHeaders,
      payload: { path: repository },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual({
      repositoryPath: repository,
      defaultName: "api-project",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: authHeaders,
      payload: { path: repository, name: "API Project" },
    });
    expect(created.statusCode).toBe(201);
    const workspace = created.json().workspace;
    expect(workspace).toMatchObject({
      name: "API Project",
      slug: "api-project",
      repositoryPath: repository,
      repository: { health: "healthy", currentBranch: "main" },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: authHeaders,
      payload: { path: repository, name: "Again" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toMatchObject({
      code: "WORKSPACE_EXISTS",
      details: { workspaceId: workspace.id },
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: baseHeaders({ cookie: authHeaders.cookie }),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().workspaces).toHaveLength(1);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspace.id}`,
      headers: authHeaders,
      payload: { name: "Renamed" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().workspace).toMatchObject({
      name: "Renamed",
      slug: "api-project",
    });

    const refreshed = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/refresh`,
      headers: authHeaders,
      payload: {},
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().workspace.repository.health).toBe("healthy");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspace.id}`,
      headers: authHeaders,
      payload: {},
    });
    expect(removed.statusCode).toBe(204);
    expect(repository).toBeTruthy();
  });

  it("reorders workspaces with stale-order protection", async () => {
    const { root, app, authHeaders } = await fixture();
    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: authHeaders,
      payload: {
        path: createGitRepository(root, "first-order"),
        name: "First",
      },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: authHeaders,
      payload: {
        path: createGitRepository(root, "second-order"),
        name: "Second",
      },
    });
    const first = firstResponse.json().workspace;
    const second = secondResponse.json().workspace;

    const reordered = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/reorder",
      headers: authHeaders,
      payload: {
        expectedWorkspaceIds: [second.id, first.id],
        workspaceIds: [first.id, second.id],
      },
    });
    expect(reordered.statusCode).toBe(200);
    expect(
      reordered
        .json()
        .workspaces.map((workspace: { id: string }) => workspace.id),
    ).toEqual([first.id, second.id]);

    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/reorder",
      headers: authHeaders,
      payload: {
        expectedWorkspaceIds: [second.id, first.id],
        workspaceIds: [second.id, first.id],
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: "WORKSPACE_ORDER_CHANGED",
      details: { workspaceIds: [first.id, second.id] },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: baseHeaders({ cookie: authHeaders.cookie }),
    });
    expect(
      listed.json().workspaces.map((workspace: { id: string }) => workspace.id),
    ).toEqual([first.id, second.id]);
  });

  it("syncs a workspace to its remote tracking branch", async () => {
    const { root, app, authHeaders } = await fixture();
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    const repository = createGitRepository(root, "sync-project");
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "--set-upstream", "origin", "main");
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: authHeaders,
      payload: { path: repository, name: "Sync Project" },
    });
    const workspace = created.json().workspace;

    const producer = join(root, "producer");
    execFileSync("git", ["clone", remote, producer], { stdio: "ignore" });
    git(producer, "config", "user.name", "Pi Dash Tests");
    git(producer, "config", "user.email", "pi-dash@example.invalid");
    writeFileSync(join(producer, "remote.txt"), "remote\n");
    git(producer, "add", "--", "remote.txt");
    git(producer, "commit", "-m", "Remote update");
    const remoteCommit = git(producer, "rev-parse", "HEAD");
    git(producer, "push", "origin", "main");

    const synced = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/sync`,
      headers: authHeaders,
      payload: {},
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json().workspace.repository).toMatchObject({
      health: "healthy",
      currentBranch: "main",
      headCommit: remoteCommit,
    });
    expect(git(repository, "rev-parse", "HEAD")).toBe(remoteCommit);

    writeFileSync(join(repository, "local.txt"), "local\n");
    const dirty = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/sync`,
      headers: authHeaders,
      payload: {},
    });
    expect(dirty.statusCode).toBe(409);
    expect(dirty.json().error).toMatchObject({
      code: "WORKSPACE_SYNC_DIRTY",
    });
  });

  it("returns not found when syncing an unknown workspace", async () => {
    const { app, authHeaders } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/00000000-0000-4000-8000-000000000099/sync",
      headers: authHeaders,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("protects workspace routes with authentication", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: baseHeaders(),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });
});
