import { existsSync } from "node:fs";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  ApiErrorCodes,
  ApiErrorEnvelopeSchema,
  APP_VERSION,
  BootstrapQuerySchema,
  DesktopRebootstrapResponseSchema,
  HealthResponseSchema,
  SessionResponseSchema,
  type BootstrapQuery,
  type DesktopRebootstrapResponse,
  type HealthResponse,
} from "@pi-dash/contracts";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import {
  equalSecret,
  REMOTE_SESSION_TTL_MS,
  SESSION_COOKIE,
  type AuthService,
  type Session,
} from "./auth.js";
import type { AppConfig } from "./config.js";
import type { DatabaseService } from "./database.js";
import { ApiHttpError } from "./errors.js";
import type { OriginPolicy, RequestAccess } from "./security.js";
import type { ApplicationEvents } from "./events/application-events.js";
import type { NativeDirectoryDialogService } from "./platform/native-directory-dialog.js";
import type { TerminalManager } from "./terminal/terminal-manager.js";
import { registerTerminalRoutes } from "./terminal/terminal-routes.js";
import { registerStatusRoutes } from "./status/status-routes.js";
import type { StatusService } from "./status/status-service.js";
import type { WorkspaceEnvironmentService } from "./workspaces/workspace-environment.js";
import type { WorkspaceService } from "./workspaces/workspace-service.js";
import { registerWorkspaceRoutes } from "./workspaces/workspace-routes.js";
import type { WorktreeService } from "./worktrees/worktree-service.js";
import { registerWorktreeRoutes } from "./worktrees/worktree-routes.js";

declare module "fastify" {
  interface FastifyRequest {
    piDashAccess?: RequestAccess;
    piDashSession?: Session;
  }
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BOOTSTRAP_PATH = "/auth/bootstrap";
const DESKTOP_REBOOTSTRAP_PATH = "/auth/desktop/rebootstrap";
const TAILSCALE_SESSION_PATH = "/auth/tailscale/session";

function cleanBootstrapFailure(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Dash launch failed</title></head><body><main><h1>Unable to launch Pi Dash</h1><p>${message}</p></main><script>history.replaceState(null,"",${JSON.stringify(BOOTSTRAP_PATH)})</script></body></html>`;
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

export function bootstrapLaunchUrl(origin: string, token: string): string {
  return `${origin}/auth/bootstrap?token=${encodeURIComponent(token)}`;
}

function bearerToken(
  header: string | string[] | undefined,
): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export interface HttpServerOptions {
  config: AppConfig;
  database: DatabaseService;
  auth: AuthService;
  policy: OriginPolicy;
  logger: Logger;
  staticDirectory: string;
  dialogs: NativeDirectoryDialogService;
  workspaces: WorkspaceService;
  environments: WorkspaceEnvironmentService;
  worktrees: WorktreeService;
  terminals: TerminalManager;
  shellTerminals: TerminalManager;
  statuses: StatusService;
  events: ApplicationEvents;
  capabilities: {
    git: boolean;
    pi: boolean;
    nativeDirectoryDialog: boolean;
    pty: boolean;
  };
}

export async function buildHttpServer(options: HttpServerOptions) {
  const app = Fastify({ loggerInstance: options.logger, trustProxy: false });
  await app.register(cookie);
  await app.register(websocket, {
    options: {
      maxPayload: options.config.terminalMaxFrameBytes,
      perMessageDeflate: false,
    },
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    if (requestPath(request) === BOOTSTRAP_PATH) {
      return reply
        .code(error instanceof ApiHttpError ? error.statusCode : 400)
        .type("text/html; charset=utf-8")
        .send(
          cleanBootstrapFailure(
            "The launch link could not be processed. Request a new link from the daemon.",
          ),
        );
    }

    let statusCode = 500;
    let code: string = ApiErrorCodes.INTERNAL_ERROR;
    let message = "An internal error occurred";
    let details: unknown;
    if (error instanceof ApiHttpError) {
      ({ statusCode, code, message, details } = error);
    } else if ("validation" in error && error.validation) {
      statusCode = 400;
      code = ApiErrorCodes.VALIDATION_ERROR;
      message = "Request validation failed";
      details = error.validation.map((issue) => ({
        instancePath: issue.instancePath,
        message: issue.message,
      }));
    } else {
      request.log.error(
        { errorName: error.name, requestId: request.id },
        "Unhandled request failure",
      );
    }
    return reply.code(statusCode).send({
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
        requestId: request.id,
      },
    });
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = requestPath(request);
    const connectSources = [
      "'self'",
      options.policy.serverOrigin.replace(/^http:/u, "ws:"),
      ...(options.policy.remoteOrigin
        ? [options.policy.remoteOrigin.replace(/^https:/u, "wss:")]
        : []),
    ];
    void reply
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
      .header(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "base-uri 'none'",
          `connect-src ${connectSources.join(" ")}`,
          "font-src 'self' data:",
          "frame-ancestors 'none'",
          "img-src 'self' data:",
          "object-src 'none'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
        ].join("; "),
      );
    if (path === BOOTSTRAP_PATH) {
      void reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header(
          "Content-Security-Policy",
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        )
        .header("X-Content-Type-Options", "nosniff");
    }
    const access = options.policy.classifyRequest(request.headers);
    if (!access) {
      throw new ApiHttpError(
        403,
        ApiErrorCodes.FORBIDDEN_ORIGIN,
        "Request host, origin, or remote identity is not allowed",
      );
    }
    request.piDashAccess = access;
  });

  app.addHook("preParsing", async (request) => {
    const path = requestPath(request);
    if (!path.startsWith("/api/v1/") || path === "/api/v1/health") return;
    const session = options.auth.authenticateRequest({
      headers: request.headers,
    });
    if (!session)
      throw new ApiHttpError(
        401,
        ApiErrorCodes.UNAUTHORIZED,
        "Authentication is required",
      );
    request.piDashSession = session;

    if (MUTATING_METHODS.has(request.method)) {
      if (
        options.auth.authenticateRequest({ headers: request.headers }, true) !==
        session
      ) {
        throw new ApiHttpError(
          403,
          ApiErrorCodes.FORBIDDEN_ORIGIN,
          "A same-origin request is required",
        );
      }
      const mediaType = request.headers["content-type"]
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "application/json") {
        throw new ApiHttpError(
          400,
          ApiErrorCodes.VALIDATION_ERROR,
          "Content-Type must be application/json",
        );
      }
      if (request.headers["x-csrf-token"] !== session.csrfToken) {
        throw new ApiHttpError(
          403,
          ApiErrorCodes.FORBIDDEN_ORIGIN,
          "CSRF token is invalid",
        );
      }
    }
  });

  app.get(
    "/api/v1/health",
    { schema: { response: { 200: HealthResponseSchema } } },
    async (request): Promise<HealthResponse> => ({
      status: "ready",
      version: APP_VERSION,
      schemaVersion: options.database.schemaVersion,
      capabilities: {
        git: options.capabilities.git ? "available" : "unavailable",
        pi: options.capabilities.pi ? "available" : "unavailable",
        nativeDirectoryDialog:
          request.piDashAccess?.channel === "local" &&
          options.capabilities.nativeDirectoryDialog
            ? "available"
            : "unavailable",
        pty: options.capabilities.pty ? "available" : "unavailable",
      },
      settings: {
        terminalCacheSize: options.config.terminalCacheSize,
        terminalMaxFrameBytes: options.config.terminalMaxFrameBytes,
      },
    }),
  );

  app.get(
    "/api/v1/session",
    {
      schema: {
        response: {
          200: SessionResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => ({
      authenticated: true as const,
      csrfToken: request.piDashSession!.csrfToken,
    }),
  );

  await registerWorkspaceRoutes(app, {
    workspaces: options.workspaces,
    environments: options.environments,
    dialogs: options.dialogs,
  });
  await registerWorktreeRoutes(app, { worktrees: options.worktrees });
  await registerTerminalRoutes(app, {
    terminals: options.terminals,
    worktrees: options.worktrees,
    auth: options.auth,
    maxFrameBytes: options.config.terminalMaxFrameBytes,
  });
  await registerTerminalRoutes(app, {
    terminals: options.shellTerminals,
    worktrees: options.worktrees,
    auth: options.auth,
    maxFrameBytes: options.config.terminalMaxFrameBytes,
    routeSegment: "shell-terminal",
  });
  await registerStatusRoutes(app, {
    statuses: options.statuses,
    events: options.events,
    worktrees: options.worktrees,
    auth: options.auth,
    maxFrameBytes: options.config.terminalMaxFrameBytes,
  });

  if (options.config.remoteAccess) {
    app.post(
      TAILSCALE_SESSION_PATH,
      {
        schema: {
          response: {
            200: SessionResponseSchema,
            401: ApiErrorEnvelopeSchema,
            403: ApiErrorEnvelopeSchema,
          },
        },
      },
      async (request, reply) => {
        const session = options.auth.exchangeTailscale({
          headers: request.headers,
        });
        if (!session) {
          throw new ApiHttpError(
            401,
            ApiErrorCodes.UNAUTHORIZED,
            "Tailscale authentication is required",
          );
        }
        void reply
          .header("Cache-Control", "no-store")
          .setCookie(SESSION_COOKIE, session.id, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
            path: "/",
            maxAge: REMOTE_SESSION_TTL_MS / 1000,
          });
        return {
          authenticated: true as const,
          csrfToken: session.csrfToken,
        };
      },
    );
  }

  app.get<{ Querystring: BootstrapQuery }>(
    BOOTSTRAP_PATH,
    { schema: { querystring: BootstrapQuerySchema } },
    async (request, reply) => {
      const session =
        request.piDashAccess?.channel === "local"
          ? options.auth.exchangeBootstrap(request.query.token)
          : undefined;
      if (!session) {
        return reply
          .code(401)
          .type("text/html; charset=utf-8")
          .send(
            cleanBootstrapFailure(
              "The launch link is invalid, expired, or has already been used.",
            ),
          );
      }
      void reply.setCookie(SESSION_COOKIE, session.id, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
      return reply.redirect(options.config.uiOrigin ?? "/", 302);
    },
  );

  if (options.config.desktopControlToken) {
    const controlToken = options.config.desktopControlToken;
    app.post(
      DESKTOP_REBOOTSTRAP_PATH,
      {
        schema: {
          response: {
            200: DesktopRebootstrapResponseSchema,
            401: ApiErrorEnvelopeSchema,
            403: ApiErrorEnvelopeSchema,
          },
        },
      },
      async (request): Promise<DesktopRebootstrapResponse> => {
        if (request.piDashAccess?.channel !== "local") {
          throw new ApiHttpError(
            403,
            ApiErrorCodes.FORBIDDEN_ORIGIN,
            "Desktop control is available only on loopback",
          );
        }
        const candidate = bearerToken(request.headers.authorization);
        if (!candidate || !equalSecret(candidate, controlToken)) {
          throw new ApiHttpError(
            401,
            ApiErrorCodes.UNAUTHORIZED,
            "Desktop control authentication is required",
          );
        }
        const token = options.auth.issueBootstrap();
        return {
          bootstrapUrl: bootstrapLaunchUrl(options.policy.serverOrigin, token),
        };
      },
    );
  }

  if (options.config.mode === "production") {
    const index = join(options.staticDirectory, "index.html");
    if (!existsSync(index))
      throw new Error(
        "Built web assets are missing; run npm run build before production start",
      );
    await app.register(fastifyStatic, {
      root: options.staticDirectory,
      wildcard: true,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    const path = requestPath(request);
    if (
      options.config.mode === "production" &&
      request.method === "GET" &&
      !path.startsWith("/api/") &&
      !path.startsWith("/auth/") &&
      request.headers.accept?.includes("text/html")
    ) {
      return reply.sendFile("index.html", { cacheControl: false });
    }
    throw new ApiHttpError(404, ApiErrorCodes.NOT_FOUND, "Route not found");
  });

  return app;
}

export type HttpServer = Awaited<ReturnType<typeof buildHttpServer>>;
