import { Type, type Static } from "@sinclair/typebox";

export * from "./diffs.js";
export * from "./status.js";
export * from "./terminal.js";
export * from "./workspaces.js";
export * from "./worktrees.js";

export const APP_VERSION = "1.0.1";
export const API_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 8;

export const CapabilityStateSchema = Type.Union([
  Type.Literal("available"),
  Type.Literal("unavailable"),
  Type.Literal("unknown"),
]);
export type CapabilityState = Static<typeof CapabilityStateSchema>;

export const HealthResponseSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("ready"),
      Type.Literal("degraded"),
      Type.Literal("migration-failed"),
    ]),
    version: Type.String(),
    schemaVersion: Type.Integer({ minimum: 0 }),
    capabilities: Type.Object({
      git: CapabilityStateSchema,
      pi: CapabilityStateSchema,
      nativeDirectoryDialog: CapabilityStateSchema,
      pty: CapabilityStateSchema,
    }),
    settings: Type.Object(
      {
        terminalCacheSize: Type.Integer({ minimum: 1, maximum: 12 }),
        terminalMaxFrameBytes: Type.Integer({
          minimum: 1024,
          maximum: 1024 * 1024,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const BootstrapQuerySchema = Type.Object(
  { token: Type.String({ minLength: 32, maxLength: 512 }) },
  { additionalProperties: false },
);
export type BootstrapQuery = Static<typeof BootstrapQuerySchema>;

export const SessionResponseSchema = Type.Object(
  {
    authenticated: Type.Literal(true),
    csrfToken: Type.String({ minLength: 32 }),
  },
  { additionalProperties: false },
);
export type SessionResponse = Static<typeof SessionResponseSchema>;

export const DesktopRebootstrapResponseSchema = Type.Object(
  {
    bootstrapUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  },
  { additionalProperties: false },
);
export type DesktopRebootstrapResponse = Static<
  typeof DesktopRebootstrapResponseSchema
>;

export const ApiErrorCodes = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN_ORIGIN: "FORBIDDEN_ORIGIN",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  MIGRATION_REQUIRED: "MIGRATION_REQUIRED",
  DIALOG_BUSY: "DIALOG_BUSY",
  DIALOG_UNAVAILABLE: "DIALOG_UNAVAILABLE",
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  PATH_INACCESSIBLE: "PATH_INACCESSIBLE",
  NOT_A_GIT_WORKTREE: "NOT_A_GIT_WORKTREE",
  WORKSPACE_EXISTS: "WORKSPACE_EXISTS",
  WORKSPACE_HAS_WORKTREES: "WORKSPACE_HAS_WORKTREES",
  WORKSPACE_ORDER_CHANGED: "WORKSPACE_ORDER_CHANGED",
  GIT_UNAVAILABLE: "GIT_UNAVAILABLE",
  GIT_TIMEOUT: "GIT_TIMEOUT",
  WORKSPACE_UNHEALTHY: "WORKSPACE_UNHEALTHY",
  WORKSPACE_SYNC_DETACHED: "WORKSPACE_SYNC_DETACHED",
  WORKSPACE_SYNC_NO_UPSTREAM: "WORKSPACE_SYNC_NO_UPSTREAM",
  WORKSPACE_SYNC_DIRTY: "WORKSPACE_SYNC_DIRTY",
  WORKSPACE_SYNC_AHEAD: "WORKSPACE_SYNC_AHEAD",
  WORKSPACE_SYNC_DIVERGED: "WORKSPACE_SYNC_DIVERGED",
  WORKSPACE_SYNC_FAILED: "WORKSPACE_SYNC_FAILED",
  BASE_REF_INVALID: "BASE_REF_INVALID",
  SNAPSHOT_INVALID: "SNAPSHOT_INVALID",
  BRANCH_INVALID: "BRANCH_INVALID",
  BRANCH_EXISTS: "BRANCH_EXISTS",
  BRANCH_CHANGED: "BRANCH_CHANGED",
  PATH_EXISTS: "PATH_EXISTS",
  GIT_OPERATION_BUSY: "GIT_OPERATION_BUSY",
  WORKTREE_CREATE_FAILED: "WORKTREE_CREATE_FAILED",
  WORKTREE_DIRTY: "WORKTREE_DIRTY",
  WORKTREE_NOT_MANAGED: "WORKTREE_NOT_MANAGED",
  WORKTREE_MISSING: "WORKTREE_MISSING",
  WORKTREE_REMOVE_FAILED: "WORKTREE_REMOVE_FAILED",
  WORKTREE_REMOVAL_CONFIRMATION_INVALID:
    "WORKTREE_REMOVAL_CONFIRMATION_INVALID",
  WORKTREE_REMOVAL_CHANGED: "WORKTREE_REMOVAL_CHANGED",
  WORKTREE_FORCE_BLOCKED: "WORKTREE_FORCE_BLOCKED",
  BRANCH_NOT_MERGED: "BRANCH_NOT_MERGED",
  IDEMPOTENCY_KEY_REQUIRED: "IDEMPOTENCY_KEY_REQUIRED",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  OPERATION_IN_PROGRESS: "OPERATION_IN_PROGRESS",
  WORKTREE_NOT_READY: "WORKTREE_NOT_READY",
  WORKTREE_UNHEALTHY: "WORKTREE_UNHEALTHY",
  DIFF_FAILED: "DIFF_FAILED",
  DIFF_TOO_LARGE: "DIFF_TOO_LARGE",
  DIFF_CHANGED: "DIFF_CHANGED",
  PI_UNAVAILABLE: "PI_UNAVAILABLE",
  PI_VERSION_UNSUPPORTED: "PI_VERSION_UNSUPPORTED",
  PTY_START_FAILED: "PTY_START_FAILED",
  RUNTIME_STARTING: "RUNTIME_STARTING",
  RUNTIME_STOPPING: "RUNTIME_STOPPING",
  TERMINAL_PROTOCOL_MISMATCH: "TERMINAL_PROTOCOL_MISMATCH",
  INVALID_RESIZE: "INVALID_RESIZE",
  OUTPUT_REPLAY_EXPIRED: "OUTPUT_REPLAY_EXPIRED",
  NOT_INPUT_OWNER: "NOT_INPUT_OWNER",
  STATUS_PROTOCOL_MISMATCH: "STATUS_PROTOCOL_MISMATCH",
  STATUS_FRAME_TOO_LARGE: "STATUS_FRAME_TOO_LARGE",
  STATUS_RUNTIME_UNKNOWN: "STATUS_RUNTIME_UNKNOWN",
  STATUS_AUTH_FAILED: "STATUS_AUTH_FAILED",
  STATUS_EVENT_INVALID: "STATUS_EVENT_INVALID",
  STATUS_REVISION_CHANGED: "STATUS_REVISION_CHANGED",
  ENVIRONMENT_SOURCE_INVALID: "ENVIRONMENT_SOURCE_INVALID",
} as const;
export type ApiErrorCode = (typeof ApiErrorCodes)[keyof typeof ApiErrorCodes];

export const ApiErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
        details: Type.Optional(Type.Unknown()),
        requestId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelopeSchema>;

export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value))
    return false;
  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string" &&
    "requestId" in error &&
    typeof error.requestId === "string"
  );
}
