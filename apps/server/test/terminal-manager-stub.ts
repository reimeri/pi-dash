import type { RuntimeDto } from "@pi-dash/contracts";
import type { TerminalManager } from "../src/terminal/terminal-manager.js";

function stopped(worktreeId: string): RuntimeDto {
  return {
    worktreeId,
    runtimeId: null,
    state: "stopped",
    startedAt: null,
    exitedAt: null,
    exitCode: null,
    signal: null,
    launchError: null,
    attachedClients: 0,
  };
}

export function createUnavailableTerminalManager(): TerminalManager {
  return {
    get: stopped,
    async start(worktreeId) {
      return stopped(worktreeId);
    },
    async stop(worktreeId) {
      return stopped(worktreeId);
    },
    async restart(worktreeId) {
      return {
        operationId: "00000000-0000-4000-8000-000000000000",
        restarted: false,
        runtime: stopped(worktreeId),
      };
    },
    async attach() {
      return () => undefined;
    },
    input() {},
    resize() {},
    async dispose() {},
    async shutdown() {},
    activities() {
      return [];
    },
    runtimes() {
      return [];
    },
    diagnostics() {
      return {
        runtimes: 0,
        attachedClients: 0,
        bufferedBytes: 0,
        foregroundCommands: 0,
      };
    },
  };
}
