import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export async function resolveExecutable(
  name: string,
  pathValue: string | undefined,
): Promise<string | undefined> {
  if (!name || name.includes("/") || name.includes("\\")) return undefined;
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue probing the remaining explicit PATH entries.
    }
  }
  return undefined;
}
