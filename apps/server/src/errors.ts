import type { ApiErrorCode } from "@pi-dash/contracts";

export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode | string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}
