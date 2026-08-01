import {
  HealthResponseSchema,
  isApiErrorEnvelope,
  SessionResponseSchema,
  type ApiErrorEnvelope,
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

async function getJson<T extends TSchema>(
  path: string,
  schema: T,
): Promise<Static<T>> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
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

export const api = {
  health: () => getJson("/api/v1/health", HealthResponseSchema),
  session: () => getJson("/api/v1/session", SessionResponseSchema),
};
