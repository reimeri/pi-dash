import type { WorktreeDto } from "@pi-dash/contracts";
import { describe, expect, it } from "vitest";
import {
  WORKTREE_VISIBLE_INITIAL,
  WORKTREE_VISIBLE_STEP,
  nextVisibleLimit,
  visibleWorktrees,
} from "../src/lib/worktrees/visible.js";

const workspaceId = "22222222-2222-4222-8222-222222222222";

function worktree(id: string, name: string): WorktreeDto {
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const ordered = Array.from({ length: 25 }, (_, index) =>
  worktree(
    `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
    `wt-${index + 1}`,
  ),
);

describe("visibleWorktrees", () => {
  it("shows the default window of 5", () => {
    expect(visibleWorktrees(ordered, WORKTREE_VISIBLE_INITIAL, undefined)).toEqual(
      ordered.slice(0, 5),
    );
  });

  it("pins a selected worktree outside the window as the last row", () => {
    const selected = ordered[11]!;
    expect(
      visibleWorktrees(ordered, WORKTREE_VISIBLE_INITIAL, selected.id),
    ).toEqual([...ordered.slice(0, 5), selected]);
  });

  it("does not duplicate a selected worktree already in the window", () => {
    const selected = ordered[2]!;
    expect(
      visibleWorktrees(ordered, WORKTREE_VISIBLE_INITIAL, selected.id),
    ).toEqual(ordered.slice(0, 5));
  });

  it("clears the pin when selection moves to an in-window worktree", () => {
    const outside = ordered[11]!;
    const inside = ordered[1]!;
    expect(
      visibleWorktrees(ordered, WORKTREE_VISIBLE_INITIAL, outside.id),
    ).toHaveLength(6);
    expect(
      visibleWorktrees(ordered, WORKTREE_VISIBLE_INITIAL, inside.id),
    ).toEqual(ordered.slice(0, 5));
  });

  it("drops the pin once the window includes the selected worktree", () => {
    const selected = ordered[11]!;
    expect(visibleWorktrees(ordered, 15, selected.id)).toEqual(
      ordered.slice(0, 15),
    );
  });

  it("ignores a selected id that is not in the ordered list", () => {
    expect(
      visibleWorktrees(
        ordered,
        WORKTREE_VISIBLE_INITIAL,
        "99999999-9999-4999-8999-999999999999",
      ),
    ).toEqual(ordered.slice(0, 5));
  });
});

describe("nextVisibleLimit", () => {
  it("steps show more and show less with clamping", () => {
    const total = 25;
    let limit = WORKTREE_VISIBLE_INITIAL;

    limit = nextVisibleLimit(limit, total, WORKTREE_VISIBLE_STEP);
    expect(limit).toBe(15);

    limit = nextVisibleLimit(limit, total, WORKTREE_VISIBLE_STEP);
    expect(limit).toBe(25);

    limit = nextVisibleLimit(limit, total, WORKTREE_VISIBLE_STEP);
    expect(limit).toBe(25);

    limit = nextVisibleLimit(limit, total, -WORKTREE_VISIBLE_STEP);
    expect(limit).toBe(15);

    limit = nextVisibleLimit(limit, total, -WORKTREE_VISIBLE_STEP);
    expect(limit).toBe(5);

    limit = nextVisibleLimit(limit, total, -WORKTREE_VISIBLE_STEP);
    expect(limit).toBe(5);
  });

  it("caps show more at the total when total is between steps", () => {
    expect(
      nextVisibleLimit(WORKTREE_VISIBLE_INITIAL, 7, WORKTREE_VISIBLE_STEP),
    ).toBe(7);
  });

  it("keeps the floor at INITIAL when total is smaller than INITIAL", () => {
    expect(nextVisibleLimit(WORKTREE_VISIBLE_INITIAL, 3, -WORKTREE_VISIBLE_STEP)).toBe(
      WORKTREE_VISIBLE_INITIAL,
    );
    expect(nextVisibleLimit(WORKTREE_VISIBLE_INITIAL, 3, WORKTREE_VISIBLE_STEP)).toBe(
      WORKTREE_VISIBLE_INITIAL,
    );
  });
});
