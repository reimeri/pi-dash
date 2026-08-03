import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ApiErrorEnvelopeSchema,
  HealthResponseSchema,
  RemoveWorktreeRequestSchema,
  RemoveWorktreeResponseSchema,
  ReorderWorkspacesRequestSchema,
  WorkspaceSchema,
  WorktreeRemovalInspectionSchema,
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

  it("validates complete bounded workspace reorder requests", () => {
    const first = "2cb84366-6fb7-4a60-b15e-6726381b190c";
    const second = "3cb84366-6fb7-4a60-b15e-6726381b190c";
    expect(
      Value.Check(ReorderWorkspacesRequestSchema, {
        expectedWorkspaceIds: [first, second],
        workspaceIds: [second, first],
      }),
    ).toBe(true);
    expect(
      Value.Check(ReorderWorkspacesRequestSchema, {
        expectedWorkspaceIds: [],
        workspaceIds: [],
      }),
    ).toBe(false);
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

  it("validates removal inspection, typed confirmation, and outcomes", () => {
    const inspection = {
      worktreeId: "2cb84366-6fb7-4a60-b15e-6726381b190c",
      checkedAt: "2026-01-01T00:00:00.000Z",
      confirmationToken: "x".repeat(32),
      expiresAt: "2026-01-01T00:05:00.000Z",
      safeRemovalAllowed: false,
      forceRemovalAllowed: true,
      expected: {
        path: "/data/worktree",
        allocatedPath: "/data/worktree",
        branchRef: "refs/heads/pi-dash/expected",
        gitCommonDir: "/repo/.git",
      },
      observed: {
        pathExists: true,
        pathKind: "directory",
        canonicalPath: "/data/worktree",
        branchRef: "refs/heads/pi-dash/observed",
        head: "a".repeat(40),
        gitCommonDir: "/repo/.git",
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
      },
      dirty: {
        available: true,
        dirty: false,
        tracked: 0,
        untracked: 0,
      },
      branchDisposition: {
        kind: "adopt_observed",
        cleanupBranchRef: "refs/heads/pi-dash/observed",
        untouchedBranchRefs: ["refs/heads/pi-dash/expected"],
      },
      removalStrategy: "git",
      issues: [
        {
          code: "BRANCH_CHANGED",
          summary: "Expected one branch and found another",
          destructive: false,
        },
      ],
      warnings: ["The recorded branch will be left untouched"],
    };
    expect(Value.Check(WorktreeRemovalInspectionSchema, inspection)).toBe(true);
    expect(
      Value.Check(RemoveWorktreeRequestSchema, {
        mode: "force",
        confirmationToken: inspection.confirmationToken,
        confirmation: "delete",
      }),
    ).toBe(true);
    expect(
      Value.Check(RemoveWorktreeRequestSchema, {
        mode: "force",
        confirmationToken: inspection.confirmationToken,
        confirmation: "DELETE",
      }),
    ).toBe(false);
    expect(
      Value.Check(RemoveWorktreeResponseSchema, {
        operationId: "5b100f2a-315f-4d9b-bb22-c1fd852c5005",
        removed: true,
        outcome: "forgotten",
        branchCleanup: null,
        warnings: ["Git metadata was left untouched"],
        worktreeId: inspection.worktreeId,
        workspaceId: "90b9a1a7-4594-40bd-88f7-6ea4a598f9f9",
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
