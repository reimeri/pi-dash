import type {
  WorktreeRecord,
  WorktreeRepository,
} from "./worktree-repository.js";

export interface WorktreeLifecycleCoordinator {
  claimRemoval(id: string): WorktreeRecord | undefined;
  restoreReady(
    id: string,
    warning?: { code: string; message: string },
  ): WorktreeRecord | undefined;
  claimTerminalStart(id: string): WorktreeRecord | undefined;
  canStartTerminal(id: string): boolean;
}

export function createWorktreeLifecycleCoordinator(options: {
  repository: WorktreeRepository;
  now?: () => Date;
}): WorktreeLifecycleCoordinator {
  const now = options.now ?? (() => new Date());
  return {
    claimRemoval(id) {
      return options.repository.compareAndSetLifecycle(
        id,
        "ready",
        "removing",
        now().toISOString(),
      );
    },
    restoreReady(id, warning) {
      const restored = options.repository.compareAndSetLifecycle(
        id,
        "removing",
        "ready",
        now().toISOString(),
      );
      if (!restored || !warning) return restored;
      return options.repository.updateState(id, {
        lastErrorCode: warning.code,
        lastErrorMessage: warning.message,
        updatedAt: now().toISOString(),
      });
    },
    claimTerminalStart(id) {
      const record = options.repository.get(id);
      return record?.lifecycle === "ready" ? record : undefined;
    },
    canStartTerminal(id) {
      return options.repository.get(id)?.lifecycle === "ready";
    },
  };
}
