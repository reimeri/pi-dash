import { realpath } from "node:fs/promises";
import type { GitRefDto } from "@pi-dash/contracts";
import { resolveExecutable } from "../process/executable.js";
import {
  ProcessExecutionError,
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../process/safe-process.js";

export class GitWorktreeError extends Error {
  constructor(
    readonly code:
      | "GIT_UNAVAILABLE"
      | "GIT_TIMEOUT"
      | "BASE_REF_INVALID"
      | "BRANCH_INVALID"
      | "BRANCH_EXISTS"
      | "PATH_EXISTS"
      | "WORKTREE_CREATE_FAILED"
      | "WORKTREE_REMOVE_FAILED"
      | "WORKTREE_MISSING"
      | "BRANCH_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "GitWorktreeError";
  }
}

export interface ListedGitRef {
  name: string;
  fullName: string;
  commit: string;
  kind: GitRefDto["kind"];
}

export interface GitWorktreeListEntry {
  path: string;
  head: string | null;
  branchRef: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

export interface DirtySummary {
  dirty: boolean;
  tracked: number;
  untracked: number;
}

export interface GitWorktreeManager {
  resolveHead(cwd: string, signal?: AbortSignal): Promise<ListedGitRef | null>;
  listRefs(
    cwd: string,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<ListedGitRef[]>;
  resolveCommit(
    cwd: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string>;
  validateBranch(
    cwd: string,
    branchRef: string,
    signal?: AbortSignal,
  ): Promise<void>;
  branchExists(
    cwd: string,
    branchRef: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  add(
    cwd: string,
    branchRef: string,
    path: string,
    baseCommit: string,
    signal?: AbortSignal,
  ): Promise<void>;
  list(cwd: string, signal?: AbortSignal): Promise<GitWorktreeListEntry[]>;
  status(path: string, signal?: AbortSignal): Promise<DirtySummary>;
  remove(
    cwd: string,
    path: string,
    signal?: AbortSignal,
    force?: "none" | "dirty" | "locked",
  ): Promise<void>;
  branchTip(
    cwd: string,
    branchRef: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
  branchMergedInto(
    cwd: string,
    branchTip: string,
    safetyTargetCommit: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  deleteBranch(
    cwd: string,
    branchRef: string,
    expectedTip: string,
    signal?: AbortSignal,
  ): Promise<void>;
  commonDir(path: string, signal?: AbortSignal): Promise<string | null>;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function value(result: ProcessResult): string {
  return result.stdout.replace(/\n$/, "");
}

export function parseWorktreePorcelain(output: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: GitWorktreeListEntry | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const fieldValue = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      if (current || !fieldValue) throw new Error("Malformed worktree list");
      current = {
        path: fieldValue,
        head: null,
        branchRef: null,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null,
      };
      continue;
    }
    if (!current) throw new Error("Malformed worktree list");
    if (key === "HEAD") {
      if (!OBJECT_ID.test(fieldValue))
        throw new Error("Malformed worktree HEAD");
      current.head = fieldValue;
    } else if (key === "branch") {
      current.branchRef = fieldValue;
    } else if (key === "detached") {
      current.detached = true;
    } else if (key === "locked") {
      current.locked = true;
      current.lockReason = fieldValue || null;
    } else if (key === "prunable") {
      current.prunable = true;
      current.prunableReason = fieldValue || null;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function parseRefs(output: string): ListedGitRef[] {
  const refs: ListedGitRef[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [fullName, object, peeled, objectType, peeledType] = line.split("\0");
    if (!fullName || !object || objectType === undefined) {
      throw new Error("Malformed Git ref list");
    }
    const commit =
      objectType === "commit"
        ? object
        : peeledType === "commit" && peeled
          ? peeled
          : undefined;
    if (!commit || !OBJECT_ID.test(commit)) continue;
    if (fullName.startsWith("refs/heads/")) {
      refs.push({
        name: fullName.slice("refs/heads/".length),
        fullName,
        commit,
        kind: "local",
      });
    } else if (fullName.startsWith("refs/tags/")) {
      refs.push({
        name: fullName.slice("refs/tags/".length),
        fullName,
        commit,
        kind: "tag",
      });
    }
  }
  return refs;
}

class CommandGitWorktreeManager implements GitWorktreeManager {
  constructor(
    private readonly executable: string | undefined,
    private readonly env: NodeJS.ProcessEnv,
    private readonly runner: ProcessRunner,
  ) {}

  private async git(
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
    timeoutMs = 15_000,
  ): Promise<ProcessResult> {
    if (!this.executable) {
      throw new GitWorktreeError("GIT_UNAVAILABLE", "Git is unavailable");
    }
    try {
      return await this.runner(this.executable, args, {
        cwd,
        env: gitEnvironment(this.env),
        signal,
        timeoutMs,
        maxOutputBytes: 128 * 1024,
      });
    } catch (error) {
      if (
        error instanceof ProcessExecutionError &&
        error.reason === "timeout"
      ) {
        throw new GitWorktreeError("GIT_TIMEOUT", "Git operation timed out");
      }
      if (
        error instanceof ProcessExecutionError &&
        error.reason === "aborted"
      ) {
        throw error;
      }
      if (error instanceof ProcessExecutionError && error.reason === "spawn") {
        throw new GitWorktreeError(
          "GIT_UNAVAILABLE",
          "Git could not be started",
        );
      }
      throw error;
    }
  }

  async resolveHead(cwd: string, signal?: AbortSignal) {
    const commitResult = await this.git(
      ["rev-parse", "--verify", "HEAD^{commit}"],
      cwd,
      signal,
    );
    if (commitResult.exitCode !== 0) return null;
    const commit = value(commitResult);
    if (!OBJECT_ID.test(commit)) return null;
    const refResult = await this.git(
      ["symbolic-ref", "--quiet", "HEAD"],
      cwd,
      signal,
    );
    const fullName = refResult.exitCode === 0 ? value(refResult) : "HEAD";
    return {
      name: fullName.startsWith("refs/heads/")
        ? fullName.slice("refs/heads/".length)
        : "HEAD",
      fullName,
      commit,
      kind: "local" as const,
    };
  }

  async listRefs(
    cwd: string,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ) {
    const result = await this.git(
      [
        "for-each-ref",
        `--count=${Math.max(limit, Math.min(100, limit * 2))}`,
        "--sort=refname",
        "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)",
        "refs/heads",
        "refs/tags",
      ],
      cwd,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new GitWorktreeError(
        "BASE_REF_INVALID",
        "Repository refs could not be listed",
      );
    }
    const needle = query.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    return parseRefs(result.stdout)
      .filter(
        (ref) =>
          !needle || ref.name.toLocaleLowerCase("en-US").includes(needle),
      )
      .slice(0, limit);
  }

  async resolveCommit(cwd: string, ref: string, signal?: AbortSignal) {
    if (
      ref !== "HEAD" &&
      !ref.startsWith("refs/heads/") &&
      !ref.startsWith("refs/tags/")
    ) {
      throw new GitWorktreeError("BASE_REF_INVALID", "Base ref is not allowed");
    }
    const result = await this.git(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      cwd,
      signal,
    );
    const commit = value(result);
    if (result.exitCode !== 0 || !OBJECT_ID.test(commit)) {
      throw new GitWorktreeError(
        "BASE_REF_INVALID",
        "Base ref does not resolve to a commit",
      );
    }
    return commit;
  }

  async validateBranch(cwd: string, branchRef: string, signal?: AbortSignal) {
    if (!branchRef.startsWith("refs/heads/")) {
      throw new GitWorktreeError("BRANCH_INVALID", "Branch ref is invalid");
    }
    const result = await this.git(
      ["check-ref-format", "--branch", branchRef.slice("refs/heads/".length)],
      cwd,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new GitWorktreeError("BRANCH_INVALID", "Branch name is invalid");
    }
  }

  async branchExists(cwd: string, branchRef: string, signal?: AbortSignal) {
    const result = await this.git(
      ["show-ref", "--verify", "--quiet", branchRef],
      cwd,
      signal,
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new GitWorktreeError(
        "BRANCH_CHANGED",
        "Branch could not be inspected",
      );
    }
    return result.exitCode === 0;
  }

  async add(
    cwd: string,
    branchRef: string,
    path: string,
    baseCommit: string,
    signal?: AbortSignal,
  ) {
    const branch = branchRef.slice("refs/heads/".length);
    const result = await this.git(
      ["worktree", "add", "-b", branch, path, baseCommit],
      cwd,
      signal,
      60_000,
    );
    if (result.exitCode !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (/already exists/i.test(combined)) {
        throw new GitWorktreeError(
          /branch/i.test(combined) ? "BRANCH_EXISTS" : "PATH_EXISTS",
          /branch/i.test(combined)
            ? "The managed branch already exists"
            : "The managed path already exists",
        );
      }
      throw new GitWorktreeError(
        "WORKTREE_CREATE_FAILED",
        "Git could not create the managed worktree",
      );
    }
  }

  async list(cwd: string, signal?: AbortSignal) {
    const result = await this.git(
      ["worktree", "list", "--porcelain", "-z"],
      cwd,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new GitWorktreeError(
        "WORKTREE_MISSING",
        "Git worktrees could not be inspected",
      );
    }
    return parseWorktreePorcelain(result.stdout);
  }

  async status(path: string, signal?: AbortSignal) {
    const result = await this.git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      path,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new GitWorktreeError(
        "WORKTREE_MISSING",
        "Managed worktree status could not be inspected",
      );
    }
    const entries = result.stdout.split("\0").filter(Boolean);
    let untracked = 0;
    for (const entry of entries) if (entry.startsWith("?? ")) untracked += 1;
    return {
      dirty: entries.length > 0,
      tracked: entries.length - untracked,
      untracked,
    };
  }

  async remove(
    cwd: string,
    path: string,
    signal?: AbortSignal,
    force: "none" | "dirty" | "locked" = "none",
  ) {
    const forceArgs =
      force === "locked"
        ? ["--force", "--force"]
        : force === "dirty"
          ? ["--force"]
          : [];
    const result = await this.git(
      ["worktree", "remove", ...forceArgs, "--", path],
      cwd,
      signal,
      60_000,
    );
    if (result.exitCode !== 0) {
      throw new GitWorktreeError(
        "WORKTREE_REMOVE_FAILED",
        "Git could not remove the managed worktree",
      );
    }
  }

  async branchTip(cwd: string, branchRef: string, signal?: AbortSignal) {
    const result = await this.git(
      ["rev-parse", "--verify", `${branchRef}^{commit}`],
      cwd,
      signal,
    );
    if (result.exitCode !== 0) return null;
    const tip = value(result);
    return OBJECT_ID.test(tip) ? tip : null;
  }

  async branchMergedInto(
    cwd: string,
    branchTip: string,
    safetyTargetCommit: string,
    signal?: AbortSignal,
  ) {
    const result = await this.git(
      ["merge-base", "--is-ancestor", branchTip, safetyTargetCommit],
      cwd,
      signal,
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitWorktreeError(
      "BRANCH_CHANGED",
      "Branch mergedness could not be verified",
    );
  }

  async deleteBranch(
    cwd: string,
    branchRef: string,
    expectedTip: string,
    signal?: AbortSignal,
  ) {
    const result = await this.git(
      ["update-ref", "-d", branchRef, expectedTip],
      cwd,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new GitWorktreeError(
        "BRANCH_CHANGED",
        "Branch changed before it could be deleted",
      );
    }
  }

  async commonDir(path: string, signal?: AbortSignal) {
    try {
      const result = await this.git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        path,
        signal,
      );
      if (result.exitCode !== 0) return null;
      return await realpath(value(result));
    } catch (error) {
      if (
        error instanceof GitWorktreeError &&
        error.code === "GIT_UNAVAILABLE"
      ) {
        throw error;
      }
      return null;
    }
  }
}

export async function createGitWorktreeManager(
  options: {
    env?: NodeJS.ProcessEnv;
    runner?: ProcessRunner;
  } = {},
): Promise<GitWorktreeManager> {
  const env = options.env ?? process.env;
  const executable = await resolveExecutable("git", env.PATH);
  return new CommandGitWorktreeManager(
    executable,
    env,
    options.runner ?? runProcess,
  );
}
