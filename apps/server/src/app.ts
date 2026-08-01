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
  HealthResponseSchema,
  SessionResponseSchema,
  type BootstrapQuery,
  type HealthResponse,
} from "@pi-dash/contracts";
import Fastify, { type FastifyError, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { SESSION_COOKIE, type AuthService, type Session } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { DatabaseService } from "./database.js";
import { ApiHttpError } from "./errors.js";
import type { OriginPolicy } from "./security.js";
import type { NativeDirectoryDialogService } from "./platform/native-directory-dialog.js";
import type { TerminalManager } from "./terminal/terminal-manager.js";
import { registerTerminalRoutes } from "./terminal/terminal-routes.js";
import type { WorkspaceService } from "./workspaces/workspace-service.js";
import { registerWorkspaceRoutes } from "./workspaces/workspace-routes.js";
import type { WorktreeService } from "./worktrees/worktree-service.js";
import { registerWorktreeRoutes } from "./worktrees/worktree-routes.js";

declare module "fastify" {
  interface FastifyRequest {
    piDashSession?: Session;
  }
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BOOTSTRAP_PATH = "/auth/bootstrap";

function cleanBootstrapFailure(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Dash launch failed</title></head><body><main><h1>Unable to launch Pi Dash</h1><p>${message}</p></main><script>history.replaceState(null,"",${JSON.stringify(BOOTSTRAP_PATH)})</script></body></html>`;
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
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
  worktrees: WorktreeService;
  terminals: TerminalManager;
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
    if (!options.policy.validateHost(request.headers)) {
      throw new ApiHttpError(
        403,
        ApiErrorCodes.FORBIDDEN_ORIGIN,
        "Request host is not allowed",
      );
    }
    if (!options.policy.validateOrigin(request.headers)) {
      throw new ApiHttpError(
        403,
        ApiErrorCodes.FORBIDDEN_ORIGIN,
        "Request origin is not allowed",
      );
    }
  });

  app.addHook("preParsing", async (request) => {
    const path = requestPath(request);
    if (!path.startsWith("/api/v1/") || path === "/api/v1/health") return;
    const session = options.auth.getSession(request.cookies[SESSION_COOKIE]);
    if (!session)
      throw new ApiHttpError(
        401,
        ApiErrorCodes.UNAUTHORIZED,
        "Authentication is required",
      );
    request.piDashSession = session;

    if (MUTATING_METHODS.has(request.method)) {
      if (!options.policy.validateOrigin(request.headers, true)) {
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
    async (): Promise<HealthResponse> => ({
      status: "ready",
      version: APP_VERSION,
      schemaVersion: options.database.schemaVersion,
      capabilities: {
        git: options.capabilities.git ? "available" : "unavailable",
        pi: options.capabilities.pi ? "available" : "unavailable",
        nativeDirectoryDialog: options.capabilities.nativeDirectoryDialog
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
    dialogs: options.dialogs,
  });
  await registerWorktreeRoutes(app, { worktrees: options.worktrees });
  await registerTerminalRoutes(app, {
    terminals: options.terminals,
    worktrees: options.worktrees,
    auth: options.auth,
    maxFrameBytes: options.config.terminalMaxFrameBytes,
  });

  app.get<{ Querystring: BootstrapQuery }>(
    BOOTSTRAP_PATH,
    { schema: { querystring: BootstrapQuerySchema } },
    async (request, reply) => {
      const session = options.auth.exchangeBootstrap(request.query.token);
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
        maxAge: 12 * 60 * 60,
      });
      return reply.redirect(options.config.uiOrigin ?? "/", 302);
    },
  );

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
