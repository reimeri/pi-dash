import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export interface AllocatedPathIdentity {
  device: string;
  inode: string;
  kind: "directory" | "symlink" | "other";
}

function mountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function contains(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export async function mountedPathsWithin(path: string): Promise<string[]> {
  if (process.platform !== "linux") return [path];
  let contents: string;
  try {
    contents = await readFile("/proc/self/mountinfo", "utf8");
  } catch {
    return [path];
  }
  const target = resolve(path);
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" - ", 1)[0]?.split(" ")[4])
    .filter((value): value is string => Boolean(value))
    .map(mountPath)
    .filter((candidate) => contains(target, resolve(candidate)))
    .sort();
}

export async function allocatedPathIdentity(
  path: string,
): Promise<AllocatedPathIdentity | undefined> {
  try {
    const metadata = await lstat(path, { bigint: true });
    return {
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      kind: metadata.isSymbolicLink()
        ? "symlink"
        : metadata.isDirectory()
          ? "directory"
          : "other",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function quarantineAllocatedPath(input: {
  path: string;
  workspaceRoot: string;
  operationId: string;
  expectedIdentity: AllocatedPathIdentity;
}): Promise<string> {
  const canonicalWorkspace = await realpath(input.workspaceRoot);
  if (
    canonicalWorkspace !== input.workspaceRoot ||
    dirname(input.path) !== canonicalWorkspace
  ) {
    throw new Error(
      "Managed worktree parent no longer has its canonical identity",
    );
  }
  const allocationRelative = relative(canonicalWorkspace, input.path);
  if (
    !allocationRelative ||
    allocationRelative.startsWith("..") ||
    isAbsolute(allocationRelative) ||
    basename(input.path) !== allocationRelative
  ) {
    throw new Error("Managed worktree path escaped its allocation directory");
  }
  const mounts = await mountedPathsWithin(input.path);
  if (mounts.length > 0) {
    throw new Error(`Mounted content blocks removal: ${mounts.join(", ")}`);
  }

  const trashRoot = resolve(canonicalWorkspace, ".pi-dash-trash");
  await mkdir(trashRoot, { recursive: true, mode: 0o700 });
  await chmod(trashRoot, 0o700);
  if ((await realpath(trashRoot)) !== trashRoot) {
    throw new Error("Managed worktree quarantine path is not canonical");
  }
  const quarantinePath = resolve(trashRoot, input.operationId);
  if (await allocatedPathIdentity(quarantinePath)) {
    throw new Error("Managed worktree quarantine allocation already exists");
  }

  await rename(input.path, quarantinePath);
  const moved = await allocatedPathIdentity(quarantinePath);
  if (
    !moved ||
    moved.device !== input.expectedIdentity.device ||
    moved.inode !== input.expectedIdentity.inode ||
    moved.kind !== input.expectedIdentity.kind
  ) {
    throw new Error(
      "Managed path identity changed before quarantine; quarantined data was not deleted",
    );
  }
  const movedMounts = await mountedPathsWithin(quarantinePath);
  if (movedMounts.length > 0) {
    throw new Error(
      `Mounted content appeared during removal: ${movedMounts.join(", ")}`,
    );
  }
  return quarantinePath;
}

export async function purgeQuarantinedPath(input: {
  path: string;
  workspaceRoot: string;
  operationId: string;
  expectedIdentity: AllocatedPathIdentity;
}): Promise<void> {
  const canonicalWorkspace = await realpath(input.workspaceRoot);
  if (canonicalWorkspace !== input.workspaceRoot) {
    throw new Error("Managed quarantine workspace is not canonical");
  }
  const trashRoot = resolve(canonicalWorkspace, ".pi-dash-trash");
  if ((await realpath(trashRoot)) !== trashRoot) {
    throw new Error("Managed quarantine parent is not canonical");
  }
  const expectedPath = resolve(trashRoot, input.operationId);
  if (input.path !== expectedPath || dirname(input.path) !== trashRoot) {
    throw new Error("Journaled quarantine path escaped its trusted allocation");
  }
  const current = await allocatedPathIdentity(input.path);
  if (
    !current ||
    current.device !== input.expectedIdentity.device ||
    current.inode !== input.expectedIdentity.inode ||
    current.kind !== input.expectedIdentity.kind
  ) {
    throw new Error(
      "Quarantine identity changed; replacement data was not deleted",
    );
  }
  const mounts = await mountedPathsWithin(input.path);
  if (mounts.length > 0) {
    throw new Error(`Mounted content blocks purge: ${mounts.join(", ")}`);
  }
  await rm(input.path, { recursive: true, force: true, maxRetries: 2 });
}
