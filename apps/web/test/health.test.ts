import { describe, expect, it } from "vitest";
import {
  healthLabel,
  repositoryHealthIssue,
  worktreeHealthIssue,
} from "../src/lib/workspaces/health.js";

describe("health issue descriptions", () => {
  it("only describes unhealthy repositories", () => {
    expect(repositoryHealthIssue("healthy")).toBeUndefined();
    expect(
      (["missing", "inaccessible", "not_git", "changed"] as const).map(
        (health) => repositoryHealthIssue(health)?.title,
      ),
    ).toEqual([
      "Repository directory is missing",
      "Repository is inaccessible",
      "Path is no longer a Git worktree",
      "Repository identity changed",
    ]);
  });

  it("describes every unhealthy worktree state", () => {
    expect(worktreeHealthIssue("healthy", "ready")).toBeUndefined();
    expect(
      (["missing", "git_mismatch", "locked", "unknown"] as const).map(
        (health) => worktreeHealthIssue(health, "ready")?.title,
      ),
    ).toEqual([
      "Worktree directory is missing",
      "Git worktree details do not match",
      "Worktree is locked",
      "Worktree health is not confirmed",
    ]);
  });

  it("distinguishes a removed worktree from an unexpectedly missing one", () => {
    expect(worktreeHealthIssue("missing", "ready")?.title).toBe(
      "Worktree directory is missing",
    );
    expect(worktreeHealthIssue("missing", "removed")?.title).toBe(
      "Worktree was removed",
    );
  });

  it("formats machine-readable health labels", () => {
    expect(healthLabel("git_mismatch")).toBe("git mismatch");
  });
});
