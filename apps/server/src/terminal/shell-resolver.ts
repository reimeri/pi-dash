import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

async function executable(
  path: string | undefined,
): Promise<string | undefined> {
  if (!path || !isAbsolute(path)) return undefined;
  try {
    const [canonical, metadata] = await Promise.all([
      realpath(path),
      stat(path),
      access(path, constants.X_OK),
    ]);
    return metadata.isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveUserShell(
  inheritedEnv: NodeJS.ProcessEnv,
  fallbackPath = "/bin/sh",
): Promise<string> {
  const configured = await executable(inheritedEnv.SHELL);
  if (configured) return configured;
  const fallback = await executable(fallbackPath);
  if (fallback) return fallback;
  throw new Error("No executable user shell is available");
}
