import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  ApiErrorEnvelopeSchema,
  ApplicationEventsClientFrameSchema,
  StatusAcknowledgeRequestSchema,
  StatusAcknowledgeResponseSchema,
  WorktreeIdParamsSchema,
  type ApplicationEventsClientFrame,
  type StatusAcknowledgeRequest,
  type WorktreeIdParams,
} from "@pi-dash/contracts";
import { Value } from "@sinclair/typebox/value";
import type { FastifyInstance } from "fastify";
import type { Logger } from "pino";
import type { RawData } from "ws";
import type { AuthService } from "../auth.js";
import type { ApplicationEvents } from "../events/application-events.js";
import { ApiHttpError } from "../errors.js";
import {
  WorktreeServiceError,
  type WorktreeService,
} from "../worktrees/worktree-service.js";
import type { StatusService } from "./status-service.js";

export async function registerStatusRoutes(
  app: FastifyInstance<
    Server,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    Logger
  >,
  options: {
    statuses: StatusService;
    events: ApplicationEvents;
    worktrees: WorktreeService;
    auth: AuthService;
    maxFrameBytes: number;
  },
): Promise<void> {
  app.post<{
    Params: WorktreeIdParams;
    Body: StatusAcknowledgeRequest;
  }>(
    "/api/v1/worktrees/:id/status/acknowledge",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        body: StatusAcknowledgeRequestSchema,
        response: {
          200: StatusAcknowledgeResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      try {
        options.worktrees.get(request.params.id);
      } catch (error) {
        if (error instanceof WorktreeServiceError) {
          throw new ApiHttpError(error.statusCode, error.code, error.message);
        }
        throw error;
      }
      const current = options.statuses.get(request.params.id);
      if (
        !current ||
        current.state !== "done" ||
        current.revision !== request.body.revision
      ) {
        throw new ApiHttpError(
          409,
          "STATUS_REVISION_CHANGED",
          "Workflow status changed before it could be acknowledged",
          current ? { status: current } : undefined,
        );
      }
      return {
        status: options.statuses.acknowledge(
          request.params.id,
          request.body.revision,
        ),
        acknowledged: true as const,
      };
    },
  );

  app.get(
    "/api/v1/events/socket",
    {
      websocket: true,
      preValidation: async (request) => {
        if (!options.auth.authenticateUpgrade({ headers: request.headers })) {
          throw new ApiHttpError(
            401,
            "UNAUTHORIZED",
            "Authenticated same-origin WebSocket access is required",
          );
        }
      },
    },
    (socket) => {
      let unsubscribe: (() => void) | undefined;
      const deadline = setTimeout(() => {
        if (!unsubscribe) socket.close(1008, "Subscribe frame required");
      }, 5_000);
      deadline.unref?.();

      socket.on("message", (raw: RawData, isBinary: boolean) => {
        if (unsubscribe || isBinary) {
          socket.close(1003, "One JSON text subscribe frame is required");
          return;
        }
        const text = raw.toString("utf8");
        if (Buffer.byteLength(text, "utf8") > options.maxFrameBytes) {
          socket.close(1009, "Frame too large");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          socket.close(1007, "Invalid JSON");
          return;
        }
        if (!Value.Check(ApplicationEventsClientFrameSchema, parsed)) {
          socket.close(1008, "Invalid subscribe frame");
          return;
        }
        void (parsed as ApplicationEventsClientFrame).afterCursor;
        clearTimeout(deadline);
        unsubscribe = options.events.subscribe({
          get bufferedAmount() {
            return socket.bufferedAmount;
          },
          send: (frame) => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify(frame));
            }
          },
          close: (code, reason) => socket.close(code, reason),
        });
      });

      const cleanup = () => {
        clearTimeout(deadline);
        unsubscribe?.();
        unsubscribe = undefined;
      };
      socket.once("close", cleanup);
      socket.once("error", cleanup);
    },
  );
}
