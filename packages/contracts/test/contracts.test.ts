import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ApiErrorEnvelopeSchema, HealthResponseSchema } from "../src/index.js";

describe("shared contracts", () => {
  it("validates the health response shape", () => {
    expect(
      Value.Check(HealthResponseSchema, {
        status: "ready",
        version: "0.1.0",
        schemaVersion: 1,
        capabilities: {
          git: "unknown",
          pi: "unknown",
          nativeDirectoryDialog: "unknown",
          pty: "unknown",
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(HealthResponseSchema, {
        status: "ready",
        databasePath: "/secret",
      }),
    ).toBe(false);
  });

  it("requires stable error envelope fields", () => {
    expect(
      Value.Check(ApiErrorEnvelopeSchema, {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication is required",
          requestId: "request-1",
        },
      }),
    ).toBe(true);
  });
});
