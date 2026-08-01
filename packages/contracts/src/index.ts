import { Type, type Static } from "@sinclair/typebox";

export const APP_VERSION = "0.1.0";
export const API_VERSION = 1;
export const CURRENT_SCHEMA_VERSION = 1;

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

export const ApiErrorCodes = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN_ORIGIN: "FORBIDDEN_ORIGIN",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  MIGRATION_REQUIRED: "MIGRATION_REQUIRED",
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
