import { constants, accessSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGED_RESOURCE_DIRECTORY = "pi-dash";

export interface DesktopRuntimePaths {
  resourceRoot: string;
  nodeExecutable: string;
  serverEntry: string;
  staticDirectory: string;
}

export function resolveDesktopRuntimePaths(options: {
  packaged: boolean;
  resourcesPath: string;
  moduleUrl: string;
  env?: NodeJS.ProcessEnv;
}): DesktopRuntimePaths {
  const repositoryRoot = resolve(
    fileURLToPath(new URL("../../..", options.moduleUrl)),
  );
  const packagedRoot = join(options.resourcesPath, PACKAGED_RESOURCE_DIRECTORY);
  const resourceRoot = options.packaged
    ? join(packagedRoot, "app")
    : repositoryRoot;
  const developmentNode =
    options.env?.PI_DASH_NODE_EXECUTABLE?.trim() || "node";
  return {
    resourceRoot,
    nodeExecutable: options.packaged
      ? join(packagedRoot, "runtime", "bin", "node")
      : developmentNode,
    serverEntry: join(resourceRoot, "apps", "server", "dist", "cli.js"),
    staticDirectory: join(resourceRoot, "apps", "web", "dist"),
  };
}

export function assertDesktopRuntimePaths(paths: DesktopRuntimePaths): void {
  if (paths.nodeExecutable.includes("/")) {
    accessSync(paths.nodeExecutable, constants.X_OK);
    if (!lstatSync(paths.nodeExecutable).isFile()) {
      throw new Error("Node executable must be a regular file");
    }
  }
  accessSync(paths.serverEntry, constants.R_OK);
  accessSync(paths.staticDirectory, constants.R_OK);
  if (!lstatSync(paths.serverEntry).isFile()) {
    throw new Error("Server entry must be a regular file");
  }
  if (!lstatSync(paths.staticDirectory).isDirectory()) {
    throw new Error("Static assets must be a directory");
  }
}
