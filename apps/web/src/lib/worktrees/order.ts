import type { WorkflowStatusDto, WorktreeDto } from "@pi-dash/contracts";

export function orderWorktreesByActivity(
  worktrees: WorktreeDto[],
  workflowStatuses: Record<string, WorkflowStatusDto>,
): WorktreeDto[] {
  const activityAt = (worktree: WorktreeDto) =>
    workflowStatuses[worktree.id]?.changedAt ?? worktree.createdAt;

  return [...worktrees].sort(
    (left, right) =>
      activityAt(right).localeCompare(activityAt(left)) ||
      right.createdAt.localeCompare(left.createdAt) ||
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }) ||
      left.id.localeCompare(right.id),
  );
}
