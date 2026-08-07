import type { WorkflowStatusDto, WorktreeDto } from "@pi-dash/contracts";

export type WorktreeActivityOrder = "newest" | "oldest";

export function orderWorktreesByActivity(
  worktrees: WorktreeDto[],
  workflowStatuses: Record<string, WorkflowStatusDto>,
  direction: WorktreeActivityOrder = "newest",
): WorktreeDto[] {
  const activityAt = (worktree: WorktreeDto) =>
    workflowStatuses[worktree.id]?.changedAt ?? worktree.createdAt;
  const newestFirst = direction === "newest";

  return [...worktrees].sort((left, right) => {
    const activityCompare = newestFirst
      ? activityAt(right).localeCompare(activityAt(left))
      : activityAt(left).localeCompare(activityAt(right));
    if (activityCompare) return activityCompare;

    const createdCompare = newestFirst
      ? right.createdAt.localeCompare(left.createdAt)
      : left.createdAt.localeCompare(right.createdAt);
    if (createdCompare) return createdCompare;

    return (
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }) || left.id.localeCompare(right.id)
    );
  });
}
