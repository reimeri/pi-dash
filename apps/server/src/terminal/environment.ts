import { join } from "node:path";

export function createTerminalEnvironment(options: {
  inherited: NodeJS.ProcessEnv;
  runtimeDirectory: string;
  runtimeId: string;
  statusToken: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.inherited)) {
    if (value !== undefined && !key.startsWith("PI_DASH_")) env[key] = value;
  }
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: env.LANG || "C.UTF-8",
    PI_DASH_STATUS_SOCKET: join(
      options.runtimeDirectory,
      `${options.runtimeId}.status.sock`,
    ),
    PI_DASH_RUNTIME_ID: options.runtimeId,
    PI_DASH_STATUS_TOKEN: options.statusToken,
  };
}
