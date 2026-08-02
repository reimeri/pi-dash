import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ApiErrorEnvelopeSchema,
  HealthResponseSchema,
  WorkspaceSchema,
  WorktreeDiffSchema,
  WorktreeDiffSummarySchema,
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
          syncStatus: "syncable",
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

  it("validates bounded worktree diff responses", () => {
    const summary = {
      worktreeId: "2cb84366-6fb7-4a60-b15e-6726381b190c",
      headCommit: "a".repeat(40),
      snapshotId: "b".repeat(64),
      hasChanges: true,
      filesChanged: 2,
      additions: 20,
      deletions: 4,
      binaryFiles: 1,
      checkedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(Value.Check(WorktreeDiffSummarySchema, summary)).toBe(true);
    expect(
      Value.Check(WorktreeDiffSchema, {
        ...summary,
        patch: "diff --git a/file.ts b/file.ts\n",
        truncated: true,
        omittedFiles: [{ path: "large.bin", reason: "patch-too-large" }],
      }),
    ).toBe(true);
    expect(
      Value.Check(WorktreeDiffSchema, {
        ...summary,
        patch: "",
        truncated: false,
        omittedFiles: [{ path: "file", reason: "unknown" }],
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
