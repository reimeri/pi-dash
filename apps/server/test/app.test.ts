import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildHttpServer, type HttpServer } from "../src/app.js";
import {
  createAuthService,
  SESSION_COOKIE,
  type AuthService,
} from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, type DatabaseService } from "../src/database.js";
import { createOriginPolicy } from "../src/security.js";
import { createGitInspector } from "../src/git/git-inspector.js";
import { createGitWorkspaceSynchronizer } from "../src/git/git-workspace-sync.js";
import { createNativeDirectoryDialog } from "../src/platform/native-directory-dialog.js";
import { createWorkspaceEnvironmentService } from "../src/workspaces/workspace-environment.js";
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

async function fixture(): Promise<{ app: HttpServer; auth: AuthService }> {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-app-"));
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
    nativeDialog: "disabled",
    logLevel: "silent",
    openBrowser: false,
    mode: "test",
  };
  const database = await openDatabase({
    path: join(root, "db.sqlite"),
    migrationsDirectory,
  });
  const policy = createOriginPolicy(config);
  const auth = createAuthService({ policy });
  const git = await createGitInspector();
  const dialogs = await createNativeDirectoryDialog({ mode: "disabled" });
  const workspaceRepository = createWorkspaceRepository(database.sqlite);
  const workspaces = createWorkspaceService({
    repository: workspaceRepository,
    git,
    syncer: await createGitWorkspaceSynchronizer(),
    lock: createGitMutationLock({ root: join(root, "locks") }),
  });
  const environments = createWorkspaceEnvironmentService({
    repository: workspaceRepository,
    liveRuntimes: () => [],
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
    environments,
    worktrees: createUnavailableWorktreeService(),
    terminals: createUnavailableTerminalManager(),
    shellTerminals: createUnavailableTerminalManager(),
    statuses: status.statuses,
    events: status.events,
    capabilities: {
      git: true,
      pi: false,
      nativeDirectoryDialog: false,
      pty: false,
    },
  });
  resources.push({ root, app, database });
  return { app, auth };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { host: "127.0.0.1:4317", ...extra };
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

describe("Fastify foundation API", () => {
  it("reports a minimal public health contract", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      version: "0.1.0",
      schemaVersion: 8,
      capabilities: {
        git: "available",
        pi: "unavailable",
        nativeDirectoryDialog: "unavailable",
        pty: "unavailable",
      },
      settings: {
        terminalCacheSize: 3,
        terminalMaxFrameBytes: 64 * 1024,
      },
    });
    expect(response.body).not.toContain("/tmp");
  });

  it("exchanges a one-use token for a strict HttpOnly session", async () => {
    const { app, auth } = await fixture();
    const bootstrap = await app.inject({
      method: "GET",
      url: `/auth/bootstrap?token=${encodeURIComponent(auth.bootstrapToken)}`,
      headers: headers(),
    });
    expect(bootstrap.statusCode).toBe(302);
    expect(bootstrap.headers["cache-control"]).toBe("no-store");
    expect(bootstrap.headers["referrer-policy"]).toBe("no-referrer");
    expect(bootstrap.headers.location).toBe("/");
    const cookie = bootstrap.cookies.find(
      (candidate) => candidate.name === SESSION_COOKIE,
    );
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });

    const session = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: headers({ cookie: `${SESSION_COOKIE}=${cookie!.value}` }),
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true });
    expect(session.json().csrfToken.length).toBeGreaterThanOrEqual(32);

    const replay = await app.inject({
      method: "GET",
      url: `/auth/bootstrap?token=${encodeURIComponent(auth.bootstrapToken)}`,
      headers: headers(),
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.headers["content-type"]).toContain("text/html");
    expect(replay.body).toContain("history.replaceState");
    expect(replay.body).not.toContain(auth.bootstrapToken);
  });

  it("enforces same-origin JSON and CSRF checks on state-changing APIs", async () => {
    const { app, auth } = await fixture();
    app.post("/api/v1/test-mutation", async () => ({ ok: true }));
    const bootstrap = await app.inject({
      method: "GET",
      url: `/auth/bootstrap?token=${encodeURIComponent(auth.bootstrapToken)}`,
      headers: headers(),
    });
    const cookie = bootstrap.cookies.find(
      (candidate) => candidate.name === SESSION_COOKIE,
    )!;
    const cookieHeader = `${SESSION_COOKIE}=${cookie.value}`;
    const sessionResponse = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: headers({ cookie: cookieHeader }),
    });
    const csrfToken = sessionResponse.json().csrfToken as string;

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/test-mutation",
      headers: headers({
        cookie: cookieHeader,
        "content-type": "application/json",
      }),
      payload: {},
    });
    expect(missingOrigin.statusCode).toBe(403);

    const wrongCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/test-mutation",
      headers: headers({
        cookie: cookieHeader,
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json",
        "x-csrf-token": "wrong",
      }),
      payload: {},
    });
    expect(wrongCsrf.statusCode).toBe(403);

    const wrongMediaType = await app.inject({
      method: "POST",
      url: "/api/v1/test-mutation",
      headers: headers({
        cookie: cookieHeader,
        origin: "http://127.0.0.1:4317",
        "content-type": "application/jsonp",
        "x-csrf-token": csrfToken,
      }),
      payload: "{}",
    });
    expect(wrongMediaType.statusCode).toBe(400);

    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/test-mutation",
      headers: headers({
        cookie: cookieHeader,
        origin: "http://127.0.0.1:4317",
        "content-type": "application/json; charset=utf-8",
        "x-csrf-token": csrfToken,
      }),
      payload: {},
    });
    expect(valid.statusCode).toBe(200);
  });

  it("returns request IDs in structured authentication and policy errors", async () => {
    const { app } = await fixture();
    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: headers(),
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json().error).toMatchObject({ code: "UNAUTHORIZED" });
    expect(unauthorized.json().error.requestId).toBeTruthy();

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "attacker.invalid", origin: "http://attacker.invalid" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("cleans failed bootstrap URLs even when query validation fails", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/auth/bootstrap?token=short-secret",
      headers: headers(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("history.replaceState");
    expect(response.body).not.toContain("short-secret");
  });
});
