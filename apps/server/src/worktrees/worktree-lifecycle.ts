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
  releaseTerminalStart(id: string): void;
  canStartTerminal(id: string): boolean;
}

export function createWorktreeLifecycleCoordinator(options: {
  repository: WorktreeRepository;
  now?: () => Date;
}): WorktreeLifecycleCoordinator {
  const now = options.now ?? (() => new Date());
  const terminalStarts = new Set<string>();
  return {
    claimRemoval(id) {
      if (terminalStarts.has(id)) return undefined;
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
      if (terminalStarts.has(id)) return undefined;
      const record = options.repository.get(id);
      if (record?.lifecycle !== "ready") return undefined;
      terminalStarts.add(id);
      return record;
    },
    releaseTerminalStart(id) {
      terminalStarts.delete(id);
    },
    canStartTerminal(id) {
      return (
        !terminalStarts.has(id) &&
        options.repository.get(id)?.lifecycle === "ready"
      );
    },
  };
}
