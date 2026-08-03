import type { WorktreeService } from "../src/worktrees/worktree-service.js";

function unavailable(): never {
  throw new Error("Worktree service is not available in this test fixture");
}

export function createUnavailableWorktreeService(): WorktreeService {
  return {
    refs: async () => unavailable(),
    list: () => unavailable(),
    get: () => unavailable(),
    diffSummary: async () => unavailable(),
    diff: async () => unavailable(),
    verifyTerminalStart: async () => unavailable(),
    create: async () => unavailable(),
    prepareRemoval: async () => unavailable(),
    remove: async () => unavailable(),
    deleteBranch: async () => unavailable(),
    reconcile: async () => undefined,
  };
}
