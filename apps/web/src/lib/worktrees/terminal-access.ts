import type { WorktreeDto } from "@pi-dash/contracts";

export function canOpenTerminal(worktree: WorktreeDto): boolean {
  return worktree.lifecycle === "ready" && worktree.health === "healthy";
}
