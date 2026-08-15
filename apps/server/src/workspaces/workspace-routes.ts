import {
  ApiErrorCodes,
  ApiErrorEnvelopeSchema,
  CreateWorkspaceRequestSchema,
  DirectoryDialogResponseSchema,
  RenameWorkspaceRequestSchema,
  ReorderWorkspacesRequestSchema,
  UpdateWorkspaceEnvironmentRequestSchema,
  WorkspaceEnvironmentResponseSchema,
  WorkspaceIdParamsSchema,
  WorkspaceListResponseSchema,
  WorkspacePathRequestSchema,
  WorkspacePreviewResponseSchema,
  WorkspaceResponseSchema,
  type CreateWorkspaceRequest,
  type RenameWorkspaceRequest,
  type ReorderWorkspacesRequest,
  type UpdateWorkspaceEnvironmentRequest,
  type WorkspaceIdParams,
  type WorkspacePathRequest,
} from "@pi-dash/contracts";
import { Type } from "@sinclair/typebox";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { ApiHttpError } from "../errors.js";
import {
  DialogBusyError,
  DialogFailureError,
  DialogUnavailableError,
  type NativeDirectoryDialogService,
} from "../platform/native-directory-dialog.js";
import { ProcessExecutionError } from "../process/safe-process.js";
import {
  WorkspaceEnvironmentError,
  type WorkspaceEnvironmentService,
} from "./workspace-environment.js";
import {
  WorkspaceServiceError,
  type WorkspaceService,
} from "./workspace-service.js";

function serviceError(error: unknown): never {
  if (error instanceof WorkspaceServiceError) {
    throw new ApiHttpError(
      error.statusCode,
      error.code,
      error.message,
      error.details,
    );
  }
  throw error;
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

export async function registerWorkspaceRoutes(
  app: FastifyInstance<
    Server,
    IncomingMessage,
    ServerResponse<IncomingMessage>,
    Logger
  >,
  options: {
    workspaces: WorkspaceService;
    environments: WorkspaceEnvironmentService;
    dialogs: NativeDirectoryDialogService;
  },
): Promise<void> {
  app.addHook("onClose", async () => {
    options.workspaces.close();
    options.environments.close();
    options.dialogs.close();
  });

  app.post(
    "/api/v1/dialogs/workspace-directory",
    {
      schema: {
        body: Type.Object({}, { additionalProperties: false }),
        response: {
          200: DirectoryDialogResponseSchema,
          403: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          503: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      if (request.piDashSession?.channel === "tailscale") {
        throw new ApiHttpError(
          403,
          ApiErrorCodes.DIALOG_UNAVAILABLE,
          "Native directory dialogs are unavailable over remote access",
        );
      }
      try {
        const result = await withRequestAbort(request, (signal) =>
          options.dialogs.chooseDirectory({ signal }),
        );
        return {
          cancelled: result.cancelled,
          path: result.path ?? null,
          adapter: result.adapter,
        };
      } catch (error) {
        if (error instanceof DialogBusyError) {
          throw new ApiHttpError(409, ApiErrorCodes.DIALOG_BUSY, error.message);
        }
        if (
          error instanceof DialogUnavailableError ||
          error instanceof DialogFailureError ||
          (error instanceof ProcessExecutionError && error.reason === "aborted")
        ) {
          throw new ApiHttpError(
            503,
            ApiErrorCodes.DIALOG_UNAVAILABLE,
            error instanceof DialogUnavailableError ||
              error instanceof DialogFailureError
              ? error.message
              : "The native directory dialog was cancelled",
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/api/v1/workspaces",
    { schema: { response: { 200: WorkspaceListResponseSchema } } },
    async () => ({ workspaces: options.workspaces.list() }),
  );

  app.post<{ Body: ReorderWorkspacesRequest }>(
    "/api/v1/workspaces/reorder",
    {
      schema: {
        body: ReorderWorkspacesRequestSchema,
        response: {
          200: WorkspaceListResponseSchema,
          400: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      try {
        return {
          workspaces: options.workspaces.reorder(
            request.body.expectedWorkspaceIds,
            request.body.workspaceIds,
          ),
        };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.get<{ Params: WorkspaceIdParams }>(
    "/api/v1/workspaces/:id",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        response: {
          200: WorkspaceResponseSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      try {
        return { workspace: options.workspaces.get(request.params.id) };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.get<{ Params: WorkspaceIdParams }>(
    "/api/v1/workspaces/:id/environment",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        response: {
          200: WorkspaceEnvironmentResponseSchema,
          404: ApiErrorEnvelopeSchema,
          422: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      try {
        options.workspaces.get(request.params.id);
        return {
          environment: options.environments.get(request.params.id),
        };
      } catch (error) {
        if (error instanceof WorkspaceEnvironmentError) {
          throw new ApiHttpError(422, error.code, error.message);
        }
        serviceError(error);
      }
    },
  );

  app.patch<{
    Params: WorkspaceIdParams;
    Body: UpdateWorkspaceEnvironmentRequest;
  }>(
    "/api/v1/workspaces/:id/environment",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        body: UpdateWorkspaceEnvironmentRequestSchema,
        response: {
          200: WorkspaceEnvironmentResponseSchema,
          404: ApiErrorEnvelopeSchema,
          422: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      try {
        options.workspaces.get(request.params.id);
        return {
          environment: options.environments.updatePrivateFile(
            request.params.id,
            request.body.privateFilePath,
          ),
        };
      } catch (error) {
        if (error instanceof WorkspaceEnvironmentError) {
          throw new ApiHttpError(422, error.code, error.message);
        }
        serviceError(error);
      }
    },
  );

  app.post<{ Body: WorkspacePathRequest }>(
    "/api/v1/workspaces/inspect",
    {
      schema: {
        body: WorkspacePathRequestSchema,
        response: { 200: WorkspacePreviewResponseSchema },
      },
    },
    async (request) => {
      try {
        return await withRequestAbort(request, (signal) =>
          options.workspaces.preview(request.body.path, signal),
        );
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Body: CreateWorkspaceRequest }>(
    "/api/v1/workspaces",
    {
      schema: {
        body: CreateWorkspaceRequestSchema,
        response: { 201: WorkspaceResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const workspace = await withRequestAbort(request, (signal) =>
          options.workspaces.create({ ...request.body, signal }),
        );
        return reply.code(201).send({ workspace });
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.patch<{
    Params: WorkspaceIdParams;
    Body: RenameWorkspaceRequest;
  }>(
    "/api/v1/workspaces/:id",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        body: RenameWorkspaceRequestSchema,
        response: { 200: WorkspaceResponseSchema },
      },
    },
    async (request) => {
      try {
        return {
          workspace: options.workspaces.rename(
            request.params.id,
            request.body.name,
          ),
        };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Params: WorkspaceIdParams }>(
    "/api/v1/workspaces/:id/refresh",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        body: Type.Object({}, { additionalProperties: false }),
        response: { 200: WorkspaceResponseSchema },
      },
    },
    async (request) => {
      try {
        return {
          workspace: await withRequestAbort(request, (signal) =>
            options.workspaces.refresh(request.params.id, signal),
          ),
        };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.post<{ Params: WorkspaceIdParams }>(
    "/api/v1/workspaces/:id/sync",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        body: Type.Object({}, { additionalProperties: false }),
        response: {
          200: WorkspaceResponseSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          502: ApiErrorEnvelopeSchema,
          503: ApiErrorEnvelopeSchema,
          504: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      try {
        return {
          workspace: await withRequestAbort(request, (signal) =>
            options.workspaces.sync(request.params.id, signal),
          ),
        };
      } catch (error) {
        serviceError(error);
      }
    },
  );

  app.delete<{ Params: WorkspaceIdParams }>(
    "/api/v1/workspaces/:id",
    {
      schema: {
        params: WorkspaceIdParamsSchema,
        body: Type.Object({}, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      try {
        options.workspaces.remove(request.params.id);
        return reply.code(204).send();
      } catch (error) {
        serviceError(error);
      }
    },
  );
}
