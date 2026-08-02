import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RESOURCE_ROOT_ENVIRONMENT_VARIABLE = "PI_DASH_RESOURCE_ROOT";

export interface AppResources {
  root: string;
  migrations: string;
  staticAssets: string;
  piExtension: string;
}

function defaultResourceRoot(): string {
  return resolve(fileURLToPath(new URL("../../..", import.meta.url)));
}

export function resolveAppResources(
  env: NodeJS.ProcessEnv = process.env,
): AppResources {
  const configuredRoot = env[RESOURCE_ROOT_ENVIRONMENT_VARIABLE]?.trim();
  if (configuredRoot && !isAbsolute(configuredRoot)) {
    throw new Error(`${RESOURCE_ROOT_ENVIRONMENT_VARIABLE} must be absolute`);
  }
  const root = configuredRoot ? resolve(configuredRoot) : defaultResourceRoot();
  return {
    root,
    migrations: join(root, "migrations"),
    staticAssets: join(root, "apps", "web", "dist"),
    piExtension: join(root, "packages", "pi-extension", "dist", "runtime.js"),
  };
}
