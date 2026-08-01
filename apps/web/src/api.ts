import {
  DirectoryDialogResponseSchema,
  HealthResponseSchema,
  isApiErrorEnvelope,
  RemoveWorktreeResponseSchema,
  RestartRuntimeResponseSchema,
  RuntimeResponseSchema,
  SessionResponseSchema,
  StatusAcknowledgeResponseSchema,
  WorkspaceListResponseSchema,
  WorkspaceRefsResponseSchema,
  WorktreeListResponseSchema,
  WorktreeResponseSchema,
  DeleteWorktreeBranchResponseSchema,
  WorkspacePreviewResponseSchema,
  WorkspaceResponseSchema,
  type ApiErrorEnvelope,
  type CreateWorkspaceRequest,
  type CreateWorktreeRequest,
  type DeleteWorktreeBranchRequest,
  type RenameWorkspaceRequest,
  type StatusAcknowledgeRequest,
  type WorkspacePathRequest,
} from "@pi-dash/contracts";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly envelope?: ApiErrorEnvelope,
    message?: string,
  ) {
    super(
      message ??
        envelope?.error.message ??
        `Request failed with status ${status}`,
    );
  }
}

let csrfToken: string | undefined;

async function requestJson<T extends TSchema>(
  path: string,
  schema: T,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
    idempotencyKey?: string;
  } = {},
): Promise<Static<T>> {
  const method = options.method ?? "GET";
  const mutating = method !== "GET";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    signal: options.signal,
    headers: {
      Accept: "application/json",
      ...(mutating
        ? {
            "Content-Type": "application/json",
            ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
            ...(options.idempotencyKey
              ? { "Idempotency-Key": options.idempotencyKey }
              : {}),
          }
        : {}),
    },
    ...(mutating ? { body: JSON.stringify(options.body ?? {}) } : {}),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      isApiErrorEnvelope(body) ? body : undefined,
    );
  }
  if (!Value.Check(schema, body)) {
    throw new ApiClientError(
      502,
      undefined,
      "The daemon returned an invalid response contract",
    );
  }
  return body;
}

async function requestEmpty(
  path: string,
  options: { method: "DELETE"; signal?: AbortSignal },
): Promise<void> {
  const response = await fetch(path, {
    method: options.method,
    credentials: "same-origin",
    signal: options.signal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify({}),
  });
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => undefined);
  throw new ApiClientError(
    response.status,
    isApiErrorEnvelope(body) ? body : undefined,
  );
}

export const api = {
  health: () => requestJson("/api/v1/health", HealthResponseSchema),
  async session() {
    const session = await requestJson("/api/v1/session", SessionResponseSchema);
    csrfToken = session.csrfToken;
    return session;
  },
  workspaces: () =>
    requestJson("/api/v1/workspaces", WorkspaceListResponseSchema),
  chooseWorkspaceDirectory: (signal?: AbortSignal) =>
    requestJson(
      "/api/v1/dialogs/workspace-directory",
      DirectoryDialogResponseSchema,
      { method: "POST", body: {}, signal },
    ),
  inspectWorkspace: (body: WorkspacePathRequest, signal?: AbortSignal) =>
    requestJson("/api/v1/workspaces/inspect", WorkspacePreviewResponseSchema, {
      method: "POST",
      body,
      signal,
    }),
  createWorkspace: (body: CreateWorkspaceRequest, signal?: AbortSignal) =>
    requestJson("/api/v1/workspaces", WorkspaceResponseSchema, {
      method: "POST",
      body,
      signal,
    }),
  renameWorkspace: (id: string, body: RenameWorkspaceRequest) =>
    requestJson(
      `/api/v1/workspaces/${encodeURIComponent(id)}`,
      WorkspaceResponseSchema,
      { method: "PATCH", body },
    ),
  refreshWorkspace: (id: string) =>
    requestJson(
      `/api/v1/workspaces/${encodeURIComponent(id)}/refresh`,
      WorkspaceResponseSchema,
      { method: "POST", body: {} },
    ),
  removeWorkspace: (id: string) =>
    requestEmpty(`/api/v1/workspaces/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  worktreeRefs: (workspaceId: string, query = "", limit = 50) =>
    requestJson(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/refs?query=${encodeURIComponent(query)}&limit=${limit}`,
      WorkspaceRefsResponseSchema,
    ),
  worktrees: (workspaceId: string) =>
    requestJson(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktrees`,
      WorktreeListResponseSchema,
    ),
  createWorktree: (
    workspaceId: string,
    body: CreateWorktreeRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) =>
    requestJson(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktrees`,
      WorktreeResponseSchema,
      { method: "POST", body, idempotencyKey, signal },
    ),
  removeWorktree: (id: string, idempotencyKey: string) =>
    requestJson(
      `/api/v1/worktrees/${encodeURIComponent(id)}/remove`,
      RemoveWorktreeResponseSchema,
      { method: "POST", body: {}, idempotencyKey },
    ),
  deleteWorktreeBranch: (
    id: string,
    body: DeleteWorktreeBranchRequest,
    idempotencyKey: string,
  ) =>
    requestJson(
      `/api/v1/worktrees/${encodeURIComponent(id)}/delete-branch`,
      DeleteWorktreeBranchResponseSchema,
      { method: "POST", body, idempotencyKey },
    ),
  reconcileWorktrees: (workspaceId: string) =>
    requestJson(
      `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/worktrees/reconcile`,
      WorktreeListResponseSchema,
      { method: "POST", body: {} },
    ),
  terminal: (worktreeId: string) =>
    requestJson(
      `/api/v1/worktrees/${encodeURIComponent(worktreeId)}/terminal`,
      RuntimeResponseSchema,
    ),
  startTerminal: (worktreeId: string) =>
    requestJson(
      `/api/v1/worktrees/${encodeURIComponent(worktreeId)}/terminal/start`,
      RuntimeResponseSchema,
      { method: "POST", body: {} },
    ),
  stopTerminal: (worktreeId: string) =>
    requestJson(
      `/api/v1/worktrees/${encodeURIComponent(worktreeId)}/terminal/stop`,
      RuntimeResponseSchema,
      { method: "POST", body: {} },
    ),
  acknowledgeStatus: (worktreeId: string, body: StatusAcknowledgeRequest) =>
    requestJson(
      `/api/v1/worktrees/${encodeURIComponent(worktreeId)}/status/acknowledge`,
      StatusAcknowledgeResponseSchema,
      { method: "POST", body },
    ),
  restartTerminal: (worktreeId: string, idempotencyKey: string) =>
    requestJson(
      `/api/v1/worktrees/${encodeURIComponent(worktreeId)}/terminal/restart`,
      RestartRuntimeResponseSchema,
      { method: "POST", body: {}, idempotencyKey },
    ),
};
