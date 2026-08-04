import type { WorktreeDto } from "@pi-dash/contracts";

export const WORKTREE_VISIBLE_INITIAL = 5;
export const WORKTREE_VISIBLE_STEP = 10;

export function nextVisibleLimit(
  current: number,
  total: number,
  delta: number,
): number {
  const upper = Math.max(WORKTREE_VISIBLE_INITIAL, total);
  return Math.min(
    upper,
    Math.max(WORKTREE_VISIBLE_INITIAL, current + delta),
  );
}

export function visibleWorktrees(
  ordered: WorktreeDto[],
  limit: number,
  selectedWorktreeId: string | undefined,
): WorktreeDto[] {
  const window = ordered.slice(0, Math.max(0, limit));
  if (!selectedWorktreeId) return window;
  if (window.some((worktree) => worktree.id === selectedWorktreeId)) {
    return window;
  }
  const selected = ordered.find(
    (worktree) => worktree.id === selectedWorktreeId,
  );
  return selected ? [...window, selected] : window;
}
