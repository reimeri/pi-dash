import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ApiErrorEnvelopeSchema,
  HealthResponseSchema,
  WorkspaceSchema,
} from "../src/index.js";

describe("shared contracts", () => {
  it("validates the health response shape", () => {
    expect(
      Value.Check(HealthResponseSchema, {
        status: "ready",
        version: "0.1.0",
        schemaVersion: 2,
        capabilities: {
          git: "unknown",
          pi: "unknown",
          nativeDirectoryDialog: "unknown",
          pty: "unknown",
        },
        settings: {
          terminalCacheSize: 3,
          terminalMaxFrameBytes: 64 * 1024,
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

  it("validates workspace health and persistence fields", () => {
    expect(
      Value.Check(WorkspaceSchema, {
        id: "2cb84366-6fb7-4a60-b15e-6726381b190c",
        name: "Pi Dash",
        slug: "pi-dash",
        repositoryPath: "/home/user/src/pi-dash",
        repository: {
          health: "healthy",
          currentBranch: "main",
          headCommit: "a".repeat(40),
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
        worktreeCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
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
