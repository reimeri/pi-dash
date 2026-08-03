import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  ApiErrorEnvelopeSchema,
  CreateWorktreeRequestSchema,
  DeleteWorktreeBranchRequestSchema,
  DeleteWorktreeBranchResponseSchema,
  EmptyObjectSchema,
  RemoveWorktreeRequestSchema,
  RemoveWorktreeResponseSchema,
  WorkspaceIdParamsSchema,
  WorkspaceRefsQuerySchema,
  WorkspaceRefsResponseSchema,
  WorktreeDiffSchema,
  WorktreeDiffSummarySchema,
  WorktreeIdParamsSchema,
  WorktreeListResponseSchema,
  WorktreeRemovalInspectionSchema,
  WorktreeResponseSchema,
  type CreateWorktreeRequest,
  type DeleteWorktreeBranchRequest,
  type RemoveWorktreeRequest,
  type WorkspaceIdParams,
  type WorkspaceRefsQuery,
  type WorktreeIdParams,
} from "@pi-dash/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { ApiHttpError } from "../errors.js";
import {
  WorktreeServiceError,
  type WorktreeService,
} from "./worktree-service.js";

const WORKTREE_ERROR_RESPONSES = {
  400: ApiErrorEnvelopeSchema,
  404: ApiErrorEnvelopeSchema,
  409: ApiErrorEnvelopeSchema,
  500: ApiErrorEnvelopeSchema,
  503: ApiErrorEnvelopeSchema,
  504: ApiErrorEnvelopeSchema,
} as const;

function serviceError(error: unknown): never {
  if (error instanceof WorktreeServiceError) {
    throw new ApiHttpError(
      error.statusCode,
      error.code,
      error.message,
      error.details,
    );
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

async function withRequestAbort<T>(
  request: FastifyRequest,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  request.raw.socket?.once("close", abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.removeListener("aborted", abort);
    request.raw.socket?.removeListener("close", abort);
  }
}

export async function registerWorktreeRoutes(
  app: FastifyInstance<
    Server,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    Logger
  >,
  options: { worktrees: WorktreeService },
): Promise<void> {
  app.get<{
    Params: WorkspaceIdParams;
    Querystring: WorkspaceRefsQuery;
  }>(
    "/api/v1/workspaces/:id/refs",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        querystring: WorkspaceRefsQuerySchema,
        response: {
          200: WorkspaceRefsResponseSchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      try {
        return await withRequestAbort(request, (signal) =>
          options.worktrees.refs(
            request.params.id,
            request.query.query,
            request.query.limit,
            signal,
          ),
        );
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.get<{ Params: WorkspaceIdParams }>(
    "/api/v1/workspaces/:id/worktrees",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        response: {
          200: WorktreeListResponseSchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      try {
        return { worktrees: options.worktrees.list(request.params.id) };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.get<{ Params: WorktreeIdParams }>(
    "/api/v1/worktrees/:id/diff-summary",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        response: {
          200: WorktreeDiffSummarySchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      try {
        void reply.header("Cache-Control", "no-store");
        return await withRequestAbort(request, (signal) =>
          options.worktrees.diffSummary(request.params.id, signal),
        );
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.get<{ Params: WorktreeIdParams }>(
    "/api/v1/worktrees/:id/diff",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        response: {
          200: WorktreeDiffSchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      try {
        void reply.header("Cache-Control", "no-store");
        return await withRequestAbort(request, (signal) =>
          options.worktrees.diff(request.params.id, signal),
        );
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{
    Params: WorkspaceIdParams;
    Body: CreateWorktreeRequest;
  }>(
    "/api/v1/workspaces/:id/worktrees",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        body: CreateWorktreeRequestSchema,
        response: {
          201: WorktreeResponseSchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      try {
        const response = await withRequestAbort(request, (signal) =>
          options.worktrees.create(
            request.params.id,
            request.body,
            idempotencyKey(request),
            signal,
          ),
        );
        return reply.code(201).send(response);
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Params: WorktreeIdParams; Body: Record<string, never> }>(
    "/api/v1/worktrees/:id/remove/prepare",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        body: EmptyObjectSchema,
        response: {
          200: WorktreeRemovalInspectionSchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        return await withRequestAbort(request, (signal) =>
          options.worktrees.prepareRemoval(request.params.id, signal),
        );
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Params: WorktreeIdParams; Body: RemoveWorktreeRequest }>(
    "/api/v1/worktrees/:id/remove",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        body: RemoveWorktreeRequestSchema,
        response: {
          200: RemoveWorktreeResponseSchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      try {
        return await withRequestAbort(request, (signal) =>
          options.worktrees.remove(
            request.params.id,
            request.body,
            idempotencyKey(request),
            signal,
          ),
        );
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{
    Params: WorktreeIdParams;
    Body: DeleteWorktreeBranchRequest;
  }>(
    "/api/v1/worktrees/:id/delete-branch",
    {
      schema: {
        params: WorktreeIdParamsSchema,
        body: DeleteWorktreeBranchRequestSchema,
        response: {
          200: DeleteWorktreeBranchResponseSchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      try {
        return await withRequestAbort(request, (signal) =>
          options.worktrees.deleteBranch(
            request.params.id,
            request.body,
            idempotencyKey(request),
            signal,
          ),
        );
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Params: WorkspaceIdParams; Body: Record<string, never> }>(
    "/api/v1/workspaces/:id/worktrees/reconcile",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        body: EmptyObjectSchema,
        response: {
          200: WorktreeListResponseSchema,
          ...WORKTREE_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      try {
        await options.worktrees.reconcile(request.params.id);
        return { worktrees: options.worktrees.list(request.params.id) };
      } catch (error) {
        serviceError(error);
      }
    },
  );
}
