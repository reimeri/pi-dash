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
  const terminalStarts = new Map<string, number>();
  return {
    claimRemoval(id) {
      if ((terminalStarts.get(id) ?? 0) > 0) return undefined;
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
      if (record?.lifecycle !== "ready") return undefined;
      terminalStarts.set(id, (terminalStarts.get(id) ?? 0) + 1);
      return record;
    },
    releaseTerminalStart(id) {
      const count = terminalStarts.get(id) ?? 0;
      if (count <= 1) terminalStarts.delete(id);
      else terminalStarts.set(id, count - 1);
    },
    canStartTerminal(id) {
      return options.repository.get(id)?.lifecycle === "ready";
    },
  };
}
