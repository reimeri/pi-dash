import { join } from "node:path";

export function createBaseTerminalEnvironment(
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !key.startsWith("PI_DASH_")) env[key] = value;
  }
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: env.LANG || "C.UTF-8",
  };
}

export function createPiTerminalEnvironment(options: {
  inherited: NodeJS.ProcessEnv;
  runtimeDirectory: string;
  runtimeId: string;
  worktreeId: string;
  statusToken: string;
}): Record<string, string> {
  return {
    ...createBaseTerminalEnvironment(options.inherited),
    PI_DASH_STATUS_SOCKET: join(options.runtimeDirectory, "status.sock"),
    PI_DASH_RUNTIME_ID: options.runtimeId,
    PI_DASH_WORKTREE_ID: options.worktreeId,
    PI_DASH_STATUS_TOKEN: options.statusToken,
  };
}

export function createShellTerminalEnvironment(
  inherited: NodeJS.ProcessEnv,
): Record<string, string> {
  return createBaseTerminalEnvironment(inherited);
}

export const createTerminalEnvironment = createPiTerminalEnvironment;
