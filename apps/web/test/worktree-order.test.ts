import type { WorkflowStatusDto, WorktreeDto } from "@pi-dash/contracts";
import { describe, expect, it } from "vitest";
import { orderWorktreesByActivity } from "../src/lib/worktrees/order.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";

function worktree(id: string, name: string, createdAt: string): WorktreeDto {
  return {
    id,
    workspaceId,
    name,
    slug: name.toLowerCase(),
    path: `/managed/${name}`,
    branchRef: `refs/heads/pi-dash/${name}`,
    baseRef: "refs/heads/main",
    baseCommit: "a".repeat(40),
    lifecycle: "ready",
    finalBranchTip: null,
    health: "healthy",
    dirty: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function status(worktreeId: string, changedAt: string): WorkflowStatusDto {
  return {
    worktreeId,
    state: "idle",
    reason: null,
    revision: 0,
    changedAt,
    acknowledgedAt: null,
    integration: "connected",
  };
}

const older = worktree(
  "11111111-1111-4111-8111-111111111111",
  "alpha",
  "2026-01-01T00:00:00.000Z",
);
const newer = worktree(
  "33333333-3333-4333-8333-333333333333",
  "zulu",
  "2026-01-02T00:00:00.000Z",
);

describe("sidebar worktree activity ordering", () => {
  it("places the most recently active worktree first", () => {
    const statuses = {
      [older.id]: status(older.id, "2026-01-04T00:00:00.000Z"),
      [newer.id]: status(newer.id, "2026-01-03T00:00:00.000Z"),
    };

    expect(orderWorktreesByActivity([newer, older], statuses)).toEqual([
      older,
      newer,
    ]);
  });

  it("places newly created worktrees first before status arrives", () => {
    const input = [older, newer];

    expect(orderWorktreesByActivity(input, {})).toEqual([newer, older]);
    expect(input).toEqual([older, newer]);
  });
});
