import { randomBytes } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "./config.js";

export interface AppPaths {
  data: string;
  config: string;
  runtime: string;
  worktrees: string;
  database: string;
  lock: string;
  runtimeInfo: string;
  snapshotKey: string;
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return realpathSync(path);
}

export function resolveAppPaths(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): AppPaths {
  const defaultData = resolve(
    env.XDG_DATA_HOME || resolve(homedir(), ".local", "share"),
    "pi-dash",
  );
  const data = privateDirectory(config.dataDir ?? defaultData);
  const configRoot = privateDirectory(
    config.configDir ??
      resolve(env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "pi-dash"),
  );
  const runtimeDefault = env.XDG_RUNTIME_DIR
    ? resolve(env.XDG_RUNTIME_DIR, "pi-dash")
    : resolve(data, "runtime");
  const runtime = privateDirectory(config.runtimeDir ?? runtimeDefault);
  return {
    data,
    config: configRoot,
    runtime,
    worktrees: privateDirectory(resolve(data, "worktrees")),
    database: resolve(data, "pi-dash.sqlite"),
    lock: resolve(data, ".daemon.lock"),
    runtimeInfo: resolve(runtime, "daemon.json"),
    snapshotKey: resolve(data, ".snapshot-signing-key"),
  };
}

export function secureWriteFile(path: string, contents: string): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const metadata = statSync(parent);
  if (
    (metadata.mode & 0o777) !== 0o700 ||
    (process.getuid && metadata.uid !== process.getuid())
  ) {
    throw new Error(
      "Secure output parent must be owned by this user with mode 0700",
    );
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function loadOrCreateSnapshotKey(path: string): Buffer {
  if (!existsSync(path))
    secureWriteFile(path, `${randomBytes(32).toString("hex")}\n`);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let encoded: string;
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (process.getuid && metadata.uid !== process.getuid())
    ) {
      throw new Error("Snapshot signing key must be a user-owned private file");
    }
    encoded = readFileSync(descriptor, "utf8").trim();
  } finally {
    closeSync(descriptor);
  }
  if (!/^[0-9a-f]{64}$/.test(encoded)) {
    throw new Error("Snapshot signing key is invalid");
  }
  return Buffer.from(encoded, "hex");
}

export function removeRuntimeFile(path: string): void {
  rmSync(path, { force: true });
}
