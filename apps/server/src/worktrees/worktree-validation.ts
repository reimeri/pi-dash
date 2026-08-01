import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class WorktreeValidationError extends Error {
  constructor(
    readonly code: "VALIDATION_ERROR" | "BRANCH_INVALID" | "PATH_EXISTS",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeValidationError";
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => /[\p{Cc}\p{Cf}]/u.test(character));
}

export function normalizeWorktreeName(input: string): string {
  const name = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name || name.length > 100 || hasControlCharacters(name)) {
    throw new WorktreeValidationError(
      "VALIDATION_ERROR",
      "Worktree name must be 1 to 100 characters without control characters",
    );
  }
  return name;
}

export function worktreeSlugBase(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || "worktree";
}

export function validateWorktreeSlug(input: string): string {
  const slug = input.normalize("NFKC");
  if (
    slug.length < 1 ||
    slug.length > 72 ||
    hasControlCharacters(slug) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    slug === "." ||
    slug === ".." ||
    slug.endsWith(".lock")
  ) {
    throw new WorktreeValidationError(
      "VALIDATION_ERROR",
      "Worktree slug must contain lowercase letters, numbers, and single hyphens",
    );
  }
  return slug;
}

export function deriveBranchRef(worktreeSlug: string): string {
  return `refs/heads/pi-dash/${worktreeSlug}`;
}

export interface AllocatedWorktreePath {
  managedRoot: string;
  workspaceRoot: string;
  path: string;
}

export function allocateWorktreePath(
  managedRoot: string,
  workspaceId: string,
  worktreeId: string,
  slug: string,
): AllocatedWorktreePath {
  if (!isAbsolute(managedRoot)) {
    throw new WorktreeValidationError(
      "VALIDATION_ERROR",
      "Managed worktree root must be absolute",
    );
  }
  mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = realpathSync(managedRoot);
  const workspaceDirectory = resolve(canonicalRoot, workspaceId);
  mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
  const canonicalWorkspaceRoot = realpathSync(workspaceDirectory);
  const rootRelative = relative(canonicalRoot, canonicalWorkspaceRoot);
  if (rootRelative.startsWith("..") || isAbsolute(rootRelative)) {
    throw new WorktreeValidationError(
      "VALIDATION_ERROR",
      "Managed workspace directory escaped the app-owned root",
    );
  }
  const path = resolve(canonicalWorkspaceRoot, `${worktreeId}-${slug}`);
  const pathRelative = relative(canonicalWorkspaceRoot, path);
  if (
    !pathRelative ||
    pathRelative.startsWith("..") ||
    isAbsolute(pathRelative)
  ) {
    throw new WorktreeValidationError(
      "VALIDATION_ERROR",
      "Managed worktree path escaped its workspace directory",
    );
  }
  try {
    lstatSync(path);
    throw new WorktreeValidationError(
      "PATH_EXISTS",
      "The allocated worktree path already exists",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    managedRoot: canonicalRoot,
    workspaceRoot: canonicalWorkspaceRoot,
    path,
  };
}

export function assertAllocatedPathAvailable(
  allocated: AllocatedWorktreePath,
): void {
  if (
    realpathSync(allocated.managedRoot) !== allocated.managedRoot ||
    realpathSync(dirname(allocated.path)) !== allocated.workspaceRoot
  ) {
    throw new WorktreeValidationError(
      "VALIDATION_ERROR",
      "Managed worktree parent changed before Git mutation",
    );
  }
  try {
    lstatSync(allocated.path);
    throw new WorktreeValidationError(
      "PATH_EXISTS",
      "The allocated worktree path already exists",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function assertCanonicalManagedPath(
  allocated: AllocatedWorktreePath,
): string {
  const canonical = realpathSync(allocated.path);
  const pathRelative = relative(allocated.workspaceRoot, canonical);
  if (
    !pathRelative ||
    pathRelative.startsWith("..") ||
    isAbsolute(pathRelative) ||
    canonical !== allocated.path
  ) {
    throw new WorktreeValidationError(
      "VALIDATION_ERROR",
      "Created worktree path failed canonical containment verification",
    );
  }
  return canonical;
}
