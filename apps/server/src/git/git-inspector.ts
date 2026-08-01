import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { RepositoryHealth } from "@pi-dash/contracts";
import { resolveExecutable } from "../process/executable.js";
import {
  ProcessExecutionError,
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../process/safe-process.js";

export type GitInspectionErrorCode =
  | "PATH_NOT_FOUND"
  | "PATH_INACCESSIBLE"
  | "VALIDATION_ERROR"
  | "NOT_A_GIT_WORKTREE"
  | "GIT_UNAVAILABLE"
  | "GIT_TIMEOUT";

export class GitInspectionError extends Error {
  constructor(
    readonly code: GitInspectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitInspectionError";
  }
}

export interface RepositoryInspection {
  repositoryPath: string;
  gitCommonDir: string;
  currentBranch: string | null;
  headCommit: string | null;
}

export interface RepositoryHealthInspection {
  health: RepositoryHealth;
  currentBranch: string | null;
  headCommit: string | null;
  checkedAt: string;
}

export interface GitInspector {
  probe(): Promise<boolean>;
  inspect(path: string, signal?: AbortSignal): Promise<RepositoryInspection>;
  inspectHealth(
    repositoryPath: string,
    expectedGitCommonDir: string,
    signal?: AbortSignal,
  ): Promise<RepositoryHealthInspection>;
}

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function pathError(error: unknown): GitInspectionError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new GitInspectionError(
      "PATH_NOT_FOUND",
      "The selected directory does not exist",
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new GitInspectionError(
      "PATH_INACCESSIBLE",
      "The selected directory is not accessible",
    );
  }
  return new GitInspectionError(
    "PATH_INACCESSIBLE",
    "The selected directory could not be inspected",
  );
}

function outputValue(result: ProcessResult): string {
  let value = result.stdout;
  if (value.endsWith("\n")) value = value.slice(0, -1);
  if (!value || value.includes("\0")) {
    throw new GitInspectionError(
      "NOT_A_GIT_WORKTREE",
      "Git returned an invalid repository path",
    );
  }
  return value;
}

function isControlCharacter(character: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(character);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(isControlCharacter);
}

export function defaultWorkspaceName(repositoryPath: string): string {
  const cleaned = [...(basename(repositoryPath) || "Workspace")]
    .map((character) => (isControlCharacter(character) ? "�" : character))
    .join("")
    .trim();
  return (cleaned || "Workspace").slice(0, 100);
}

class CommandGitInspector implements GitInspector {
  constructor(
    private readonly executable: string | undefined,
    private readonly env: NodeJS.ProcessEnv,
    private readonly runner: ProcessRunner,
    private readonly now: () => Date,
  ) {}

  async probe(): Promise<boolean> {
    if (!this.executable) return false;
    try {
      const result = await this.runner(this.executable, ["--version"], {
        cwd: this.env.HOME || "/",
        env: gitEnvironment(this.env),
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      });
      return result.exitCode === 0 && result.stdout.startsWith("git version ");
    } catch {
      return false;
    }
  }

  private async git(
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (!this.executable) {
      throw new GitInspectionError(
        "GIT_UNAVAILABLE",
        "The Git executable is unavailable",
      );
    }
    try {
      return await this.runner(this.executable, args, {
        cwd,
        env: gitEnvironment(this.env),
        signal,
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
      });
    } catch (error) {
      if (
        error instanceof ProcessExecutionError &&
        error.reason === "timeout"
      ) {
        throw new GitInspectionError("GIT_TIMEOUT", "Git inspection timed out");
      }
      if (
        error instanceof ProcessExecutionError &&
        error.reason === "aborted"
      ) {
        throw error;
      }
      if (error instanceof ProcessExecutionError && error.reason === "spawn") {
        const causeCode = (error.cause as NodeJS.ErrnoException | undefined)
          ?.code;
        if (causeCode === "EACCES" || causeCode === "EPERM") {
          throw new GitInspectionError(
            "PATH_INACCESSIBLE",
            "The selected directory is not accessible",
          );
        }
        throw new GitInspectionError(
          "GIT_UNAVAILABLE",
          "The Git executable could not be started",
        );
      }
      throw new GitInspectionError(
        "NOT_A_GIT_WORKTREE",
        "Git returned too much or invalid output",
      );
    }
  }

  async inspect(
    selectedPath: string,
    signal?: AbortSignal,
  ): Promise<RepositoryInspection> {
    if (!isAbsolute(selectedPath)) {
      throw new GitInspectionError(
        "VALIDATION_ERROR",
        "Repository path must be absolute",
      );
    }
    let canonicalSelection: string;
    try {
      canonicalSelection = await realpath(selectedPath);
      const selectedInfo = await stat(canonicalSelection);
      if (!selectedInfo.isDirectory()) {
        throw new GitInspectionError(
          "PATH_INACCESSIBLE",
          "The selected path is not a directory",
        );
      }
      await access(canonicalSelection, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof GitInspectionError) throw error;
      throw pathError(error);
    }

    const topLevelResult = await this.git(
      ["rev-parse", "--show-toplevel"],
      canonicalSelection,
      signal,
    );
    if (topLevelResult.exitCode !== 0) {
      if (
        topLevelResult.stderr.includes("Permission denied") ||
        topLevelResult.stderr.includes("Operation not permitted")
      ) {
        throw new GitInspectionError(
          "PATH_INACCESSIBLE",
          "The selected directory is not accessible",
        );
      }
      throw new GitInspectionError(
        "NOT_A_GIT_WORKTREE",
        "The selected directory is not inside a Git worktree",
      );
    }

    let repositoryPath: string;
    try {
      repositoryPath = await realpath(outputValue(topLevelResult));
      if (!(await stat(repositoryPath)).isDirectory()) throw new Error();
      await access(repositoryPath, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof GitInspectionError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw pathError(error);
      throw new GitInspectionError(
        "NOT_A_GIT_WORKTREE",
        "Git did not return a usable worktree directory",
      );
    }

    const commonDirResult = await this.git(
      ["rev-parse", "--git-common-dir"],
      repositoryPath,
      signal,
    );
    if (commonDirResult.exitCode !== 0) {
      if (
        commonDirResult.stderr.includes("Permission denied") ||
        commonDirResult.stderr.includes("Operation not permitted")
      ) {
        throw new GitInspectionError(
          "PATH_INACCESSIBLE",
          "The repository metadata is not accessible",
        );
      }
      throw new GitInspectionError(
        "NOT_A_GIT_WORKTREE",
        "Git did not return repository metadata",
      );
    }
    const commonDirOutput = outputValue(commonDirResult);
    let gitCommonDir: string;
    try {
      gitCommonDir = await realpath(
        isAbsolute(commonDirOutput)
          ? commonDirOutput
          : resolve(repositoryPath, commonDirOutput),
      );
      if (!(await stat(gitCommonDir)).isDirectory()) throw new Error();
      await access(gitCommonDir, constants.R_OK | constants.X_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") throw pathError(error);
      throw new GitInspectionError(
        "NOT_A_GIT_WORKTREE",
        "The repository metadata directory is invalid",
      );
    }

    const branchResult = await this.git(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      repositoryPath,
      signal,
    );
    const currentBranch =
      branchResult.exitCode === 0 ? outputValue(branchResult) : null;
    if (
      currentBranch &&
      (currentBranch.length > 1024 || hasControlCharacters(currentBranch))
    ) {
      throw new GitInspectionError(
        "NOT_A_GIT_WORKTREE",
        "Git returned an invalid branch name",
      );
    }

    const headResult = await this.git(
      ["rev-parse", "--verify", "HEAD"],
      repositoryPath,
      signal,
    );
    const headCommit =
      headResult.exitCode === 0 ? outputValue(headResult) : null;
    if (headCommit && !/^[0-9a-f]{40,64}$/.test(headCommit)) {
      throw new GitInspectionError(
        "NOT_A_GIT_WORKTREE",
        "Git returned an invalid HEAD commit",
      );
    }

    return {
      repositoryPath,
      gitCommonDir,
      currentBranch,
      headCommit,
    };
  }

  async inspectHealth(
    repositoryPath: string,
    expectedGitCommonDir: string,
    signal?: AbortSignal,
  ): Promise<RepositoryHealthInspection> {
    const checkedAt = this.now().toISOString();
    try {
      const inspection = await this.inspect(repositoryPath, signal);
      return {
        health:
          inspection.repositoryPath === repositoryPath &&
          inspection.gitCommonDir === expectedGitCommonDir
            ? "healthy"
            : "changed",
        currentBranch: inspection.currentBranch,
        headCommit: inspection.headCommit,
        checkedAt,
      };
    } catch (error) {
      if (!(error instanceof GitInspectionError)) throw error;
      if (error.code === "GIT_UNAVAILABLE" || error.code === "GIT_TIMEOUT") {
        throw error;
      }
      return {
        health:
          error.code === "PATH_NOT_FOUND"
            ? "missing"
            : error.code === "PATH_INACCESSIBLE"
              ? "inaccessible"
              : "not_git",
        currentBranch: null,
        headCommit: null,
        checkedAt,
      };
    }
  }
}

export async function createGitInspector(
  options: {
    env?: NodeJS.ProcessEnv;
    runner?: ProcessRunner;
    now?: () => Date;
  } = {},
): Promise<GitInspector> {
  const env = options.env ?? process.env;
  const executable = await resolveExecutable("git", env.PATH);
  return new CommandGitInspector(
    executable,
    env,
    options.runner ?? runProcess,
    options.now ?? (() => new Date()),
  );
}
