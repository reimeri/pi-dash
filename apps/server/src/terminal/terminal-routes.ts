import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  ApiErrorEnvelopeSchema,
  EmptyObjectSchema,
  RestartRuntimeResponseSchema,
  RuntimeResponseSchema,
  WorktreeIdParamsSchema,
  type TerminalServerFrame,
  type WorktreeIdParams,
} from "@pi-dash/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import type { RawData, WebSocket } from "ws";
import type { AuthService } from "../auth.js";
import { ApiHttpError } from "../errors.js";
import {
  WorktreeServiceError,
  type WorktreeService,
} from "../worktrees/worktree-service.js";
import {
  TerminalManagerError,
  type TerminalManager,
} from "./terminal-manager.js";
import { parseTerminalClientFrame } from "./terminal-protocol.js";

const TERMINAL_ERROR_RESPONSES = {
  400: ApiErrorEnvelopeSchema,
  401: ApiErrorEnvelopeSchema,
  403: ApiErrorEnvelopeSchema,
  404: ApiErrorEnvelopeSchema,
  409: ApiErrorEnvelopeSchema,
  500: ApiErrorEnvelopeSchema,
  503: ApiErrorEnvelopeSchema,
} as const;

function serviceError(error: unknown): never {
  if (
    error instanceof TerminalManagerError ||
    error instanceof WorktreeServiceError
  ) {
    throw new ApiHttpError(error.statusCode, error.code, error.message);
  }
  throw error;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (
    typeof value !== "string" ||
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  ) {
    throw new ApiHttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A UUID Idempotency-Key header is required",
    );
  }
  return value.toLowerCase();
}

function sendSocket(socket: WebSocket, frame: TerminalServerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

export async function registerTerminalRoutes(
  app: FastifyInstance<
    Server,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    Logger
  >,
  options: {
    terminals: TerminalManager;
    worktrees: WorktreeService;
    auth: AuthService;
    maxFrameBytes: number;
  },
): Promise<void> {
  app.get<{ Params: WorktreeIdParams }>(
    "/api/v1/worktrees/:id/terminal",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        response: { 200: RuntimeResponseSchema, ...TERMINAL_ERROR_RESPONSES },
      },
    },
    async (request) => {
      try {
        return { runtime: options.terminals.get(request.params.id) };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Params: WorktreeIdParams; Body: Record<string, never> }>(
    "/api/v1/worktrees/:id/terminal/start",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        body: EmptyObjectSchema,
        response: { 200: RuntimeResponseSchema, ...TERMINAL_ERROR_RESPONSES },
      },
    },
    async (request) => {
      try {
        return { runtime: await options.terminals.start(request.params.id) };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Params: WorktreeIdParams; Body: Record<string, never> }>(
    "/api/v1/worktrees/:id/terminal/stop",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        body: EmptyObjectSchema,
        response: { 200: RuntimeResponseSchema, ...TERMINAL_ERROR_RESPONSES },
      },
    },
    async (request) => {
      try {
        return { runtime: await options.terminals.stop(request.params.id) };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Params: WorktreeIdParams; Body: Record<string, never> }>(
    "/api/v1/worktrees/:id/terminal/restart",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        body: EmptyObjectSchema,
        response: {
          200: RestartRuntimeResponseSchema,
          ...TERMINAL_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      try {
        return await options.terminals.restart(
          request.params.id,
          idempotencyKey(request),
        );
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.get<{ Params: WorktreeIdParams }>(
    "/api/v1/worktrees/:id/terminal/socket",
    {
      websocket: true,
      schema: { params: WorktreeIdParamsSchema },
      preValidation: async (request) => {
        if (!options.auth.authenticateUpgrade({ headers: request.headers })) {
          throw new ApiHttpError(
            401,
            "UNAUTHORIZED",
            "Authenticated same-origin WebSocket access is required",
          );
        }
        try {
          options.worktrees.get(request.params.id);
        } catch (error) {
          serviceError(error);
        }
      },
    },
    (socket, request) => {
      const worktreeId = request.params.id;
      const connectionId = randomUUID();
      let detach: (() => void) | undefined;
      let attached = false;
      let lastHeartbeat = Date.now();
      const attachDeadline = setTimeout(() => {
        if (!attached) socket.close(1008, "Attach frame required");
      }, 5_000);
      attachDeadline.unref?.();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastHeartbeat > 90_000) {
          socket.close(1013, "Terminal heartbeat expired");
        }
      }, 30_000);
      heartbeat.unref?.();

      const sendError = (code: string, message: string) =>
        sendSocket(socket, { v: 1, type: "error", code, message });

      socket.on("message", (raw: RawData, isBinary: boolean) => {
        if (isBinary) {
          sendError(
            "VALIDATION_ERROR",
            "WebSocket frames must contain JSON text",
          );
          socket.close(1003, "JSON text required");
          return;
        }
        const text = raw.toString("utf8");
        if (Buffer.byteLength(text, "utf8") > options.maxFrameBytes) {
          sendError(
            "VALIDATION_ERROR",
            "Terminal frame exceeds the configured limit",
          );
          socket.close(1009, "Frame too large");
          return;
        }
        const parsed = parseTerminalClientFrame(text);
        if (!parsed.ok) {
          sendError(parsed.code, parsed.message);
          if (parsed.close) socket.close(parsed.close, parsed.message);
          return;
        }
        const frame = parsed.frame;
        try {
          if (frame.type === "attach") {
            if (attached) {
              sendError("VALIDATION_ERROR", "Connection is already attached");
              return;
            }
            detach = options.terminals.attach(
              worktreeId,
              connectionId,
              frame.afterSeq,
              {
                get bufferedAmount() {
                  return socket.bufferedAmount;
                },
                send: (serverFrame) => sendSocket(socket, serverFrame),
                close: (code, reason) => socket.close(code, reason),
              },
            );
            attached = true;
            clearTimeout(attachDeadline);
            return;
          }
          if (!attached) {
            sendError("VALIDATION_ERROR", "Attach before using the terminal");
            return;
          }
          if (frame.type === "input") {
            options.terminals.input(worktreeId, connectionId, frame.data);
          } else if (frame.type === "binaryInput") {
            options.terminals.input(
              worktreeId,
              connectionId,
              Buffer.from(frame.dataBase64, "base64"),
            );
          } else if (frame.type === "resize") {
            options.terminals.resize(
              worktreeId,
              connectionId,
              frame.cols,
              frame.rows,
            );
          } else if (frame.type === "ping") {
            lastHeartbeat = Date.now();
            sendSocket(socket, { v: 1, type: "pong", nonce: frame.nonce });
          }
        } catch (error) {
          if (error instanceof TerminalManagerError) {
            sendError(error.code, error.message);
          } else {
            request.log.error(
              { errorName: (error as Error).name, connectionId },
              "Terminal WebSocket message failed",
            );
            sendError("INTERNAL_ERROR", "Terminal request failed");
          }
        }
      });

      const cleanup = () => {
        clearTimeout(attachDeadline);
        clearInterval(heartbeat);
        detach?.();
        detach = undefined;
      };
      socket.once("close", cleanup);
      socket.once("error", cleanup);
    },
  );
}
