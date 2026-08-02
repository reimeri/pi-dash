import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffOmittedFile } from "@pi-dash/contracts";
import { resolveExecutable } from "../process/executable.js";
import {
  ProcessExecutionError,
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../process/safe-process.js";

export interface GitDiffSummary {
  headCommit: string;
  snapshotId: string;
  hasChanges: boolean;
  filesChanged: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
}

export interface GitDiffSnapshot extends GitDiffSummary {
  patch: string;
  truncated: boolean;
  omittedFiles: DiffOmittedFile[];
}

export class GitDiffError extends Error {
  constructor(
    readonly code:
      | "GIT_UNAVAILABLE"
      | "GIT_TIMEOUT"
      | "DIFF_TOO_LARGE"
      | "DIFF_CHANGED"
      | "DIFF_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitDiffError";
  }
}

export interface GitDiffInspector {
  summary(path: string, signal?: AbortSignal): Promise<GitDiffSummary>;
  snapshot(path: string, signal?: AbortSignal): Promise<GitDiffSnapshot>;
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 10_000;
const MAX_RENDERED_FILES = 200;
const MAX_FILE_PATCH_BYTES = 1024 * 1024;
const MAX_TOTAL_PATCH_BYTES = 5 * 1024 * 1024;
const MAX_FINGERPRINT_PATCH_BYTES = 64 * 1024 * 1024;
const INSPECTION_TIMEOUT_MS = 15_000;

function gitEnvironment(
  env: NodeJS.ProcessEnv,
  indexPath: string,
): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_INDEX_FILE: indexPath,
  };
}

function outputValue(result: ProcessResult): string {
  return result.stdout.replace(/\n$/, "");
}

interface ChangedFile {
  path: string;
  pathspecs: string[];
}

function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[index + 1];
      const newPath = fields[index + 2];
      if (!oldPath || !newPath) {
        throw new GitDiffError(
          "DIFF_FAILED",
          "Git returned malformed rename metadata",
        );
      }
      files.push({ path: newPath, pathspecs: [oldPath, newPath] });
      index += 2;
      continue;
    }
    const path = fields[index + 1];
    if (!path) {
      throw new GitDiffError(
        "DIFF_FAILED",
        "Git returned malformed changed-file metadata",
      );
    }
    files.push({ path, pathspecs: [path] });
    index += 1;
  }
  return files;
}

function parseNumstat(output: string): {
  additions: number;
  deletions: number;
  binaryFiles: number;
} {
  const fields = output.split("\0");
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const firstTab = field.indexOf("\t");
    const secondTab = field.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < 0) {
      throw new GitDiffError(
        "DIFF_FAILED",
        "Git returned malformed diff statistics",
      );
    }
    const added = field.slice(0, firstTab);
    const deleted = field.slice(firstTab + 1, secondTab);
    const path = field.slice(secondTab + 1);
    if (!path) index += 2; // Rename records carry old and new paths separately.
    if (added === "-" || deleted === "-") {
      binaryFiles += 1;
      continue;
    }
    const addedCount = Number(added);
    const deletedCount = Number(deleted);
    if (
      !Number.isSafeInteger(addedCount) ||
      !Number.isSafeInteger(deletedCount)
    ) {
      throw new GitDiffError(
        "DIFF_FAILED",
        "Git returned invalid diff statistics",
      );
    }
    additions += addedCount;
    deletions += deletedCount;
  }
  return { additions, deletions, binaryFiles };
}

class CommandGitDiffInspector implements GitDiffInspector {
  constructor(
    private readonly executable: string | undefined,
    private readonly env: NodeJS.ProcessEnv,
    private readonly runner: ProcessRunner,
  ) {}

  private async git(
    args: readonly string[],
    cwd: string,
    indexPath: string,
    signal?: AbortSignal,
    options: { maxOutputBytes?: number; stdin?: string | Buffer } = {},
  ): Promise<ProcessResult> {
    if (!this.executable) {
      throw new GitDiffError("GIT_UNAVAILABLE", "Git is unavailable");
    }
    try {
      return await this.runner(
        this.executable,
        ["--literal-pathspecs", ...args],
        {
          cwd,
          env: gitEnvironment(this.env, indexPath),
          signal,
          timeoutMs: 15_000,
          maxOutputBytes: options.maxOutputBytes ?? MANIFEST_MAX_BYTES,
          stdin: options.stdin,
        },
      );
    } catch (error) {
      if (error instanceof ProcessExecutionError) {
        if (error.reason === "aborted") throw error;
        if (error.reason === "timeout") {
          throw new GitDiffError(
            "GIT_TIMEOUT",
            "Git diff inspection timed out",
          );
        }
        if (error.reason === "spawn") {
          throw new GitDiffError("GIT_UNAVAILABLE", "Git could not be started");
        }
        if (error.reason === "output_limit") {
          throw new GitDiffError(
            "DIFF_TOO_LARGE",
            "Git diff exceeded its safety limit",
          );
        }
      }
      throw error;
    }
  }

  private async command(
    args: readonly string[],
    cwd: string,
    indexPath: string,
    signal?: AbortSignal,
    options?: { maxOutputBytes?: number; stdin?: string | Buffer },
  ): Promise<ProcessResult> {
    const result = await this.git(args, cwd, indexPath, signal, options);
    if (result.exitCode !== 0) {
      throw new GitDiffError(
        "DIFF_FAILED",
        "Git could not inspect worktree changes",
      );
    }
    return result;
  }

  private async includeUntracked(
    path: string,
    indexPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const untracked = await this.command(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      path,
      indexPath,
      signal,
    );
    if (untracked.stdout) {
      await this.command(
        [
          "add",
          "--intent-to-add",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        path,
        indexPath,
        signal,
        { stdin: untracked.stdout },
      );
    }
  }

  private async withTemporaryIndex<T>(
    path: string,
    signal: AbortSignal | undefined,
    inspect: (indexPath: string) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), "pi-dash-diff-"));
    const indexPath = join(directory, "index");
    try {
      await this.command(["read-tree", "HEAD"], path, indexPath, signal);
      await this.includeUntracked(path, indexPath, signal);
      return await inspect(indexPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async withDeadline<T>(
    signal: AbortSignal | undefined,
    operation: (deadlineSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(INSPECTION_TIMEOUT_MS);
    const deadlineSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    try {
      return await operation(deadlineSignal);
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) {
        throw new GitDiffError("GIT_TIMEOUT", "Git diff inspection timed out");
      }
      throw error;
    }
  }

  private patchArgs(pathspecs: readonly string[] = []): string[] {
    return [
      "diff",
      "--patch",
      "--full-index",
      "--find-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "HEAD",
      "--",
      ...pathspecs,
    ];
  }

  private async metadata(
    path: string,
    indexPath: string,
    signal?: AbortSignal,
  ): Promise<{
    summary: GitDiffSummary;
    files: ChangedFile[];
  }> {
    const [headResult, pathsResult, numstatResult] = await Promise.all([
      this.command(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        path,
        indexPath,
        signal,
      ),
      this.command(
        [
          "diff",
          "--name-status",
          "-z",
          "--find-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=none",
          "HEAD",
          "--",
        ],
        path,
        indexPath,
        signal,
      ),
      this.command(
        [
          "diff",
          "--numstat",
          "-z",
          "--find-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--ignore-submodules=none",
          "HEAD",
          "--",
        ],
        path,
        indexPath,
        signal,
      ),
    ]);
    const headCommit = outputValue(headResult);
    if (!OBJECT_ID.test(headCommit)) {
      throw new GitDiffError(
        "DIFF_FAILED",
        "Git returned an invalid worktree HEAD",
      );
    }
    const files = parseNameStatus(pathsResult.stdout);
    if (files.length > MAX_CHANGED_FILES) {
      throw new GitDiffError(
        "DIFF_TOO_LARGE",
        "Worktree has too many changed files to inspect safely",
      );
    }
    const stats = parseNumstat(numstatResult.stdout);
    const snapshotId = createHash("sha256")
      .update(headCommit)
      .update("\0")
      .update(pathsResult.stdout)
      .update("\0")
      .update(numstatResult.stdout)
      .digest("hex");
    return {
      files,
      summary: {
        headCommit,
        snapshotId,
        hasChanges: files.length > 0,
        filesChanged: files.length,
        ...stats,
      },
    };
  }

  async summary(path: string, signal?: AbortSignal): Promise<GitDiffSummary> {
    return this.withDeadline(signal, (deadlineSignal) =>
      this.withTemporaryIndex(path, deadlineSignal, async (indexPath) => {
        const result = await this.metadata(path, indexPath, deadlineSignal);
        return result.summary;
      }),
    );
  }

  async snapshot(path: string, signal?: AbortSignal): Promise<GitDiffSnapshot> {
    return this.withDeadline(signal, (deadlineSignal) =>
      this.withTemporaryIndex(path, deadlineSignal, async (indexPath) => {
        const firstPatch = await this.command(
          this.patchArgs(),
          path,
          indexPath,
          deadlineSignal,
          { maxOutputBytes: MAX_FINGERPRINT_PATCH_BYTES },
        );
        const { summary, files } = await this.metadata(
          path,
          indexPath,
          deadlineSignal,
        );
        const patches: string[] = [];
        const omittedFiles: DiffOmittedFile[] = [];
        if (
          Buffer.byteLength(firstPatch.stdout) > MAX_TOTAL_PATCH_BYTES ||
          files.length > MAX_RENDERED_FILES
        ) {
          omittedFiles.push(
            ...files.slice(MAX_RENDERED_FILES).map((file) => ({
              path: file.path,
              reason: "file-limit" as const,
            })),
          );
          let patchBytes = 0;
          for (const file of files.slice(0, MAX_RENDERED_FILES)) {
            let result: ProcessResult;
            try {
              result = await this.command(
                this.patchArgs(file.pathspecs),
                path,
                indexPath,
                deadlineSignal,
                { maxOutputBytes: MAX_FILE_PATCH_BYTES },
              );
            } catch (error) {
              if (
                error instanceof GitDiffError &&
                error.code === "DIFF_TOO_LARGE"
              ) {
                omittedFiles.push({
                  path: file.path,
                  reason: "patch-too-large",
                });
                continue;
              }
              throw error;
            }
            const bytes = Buffer.byteLength(result.stdout);
            if (patchBytes + bytes > MAX_TOTAL_PATCH_BYTES) {
              omittedFiles.push({
                path: file.path,
                reason: "patch-too-large",
              });
              continue;
            }
            patchBytes += bytes;
            patches.push(result.stdout);
          }
        }

        await this.includeUntracked(path, indexPath, deadlineSignal);
        const secondPatch = await this.command(
          this.patchArgs(),
          path,
          indexPath,
          deadlineSignal,
          { maxOutputBytes: MAX_FINGERPRINT_PATCH_BYTES },
        );
        const firstFingerprint = createHash("sha256")
          .update(firstPatch.stdout)
          .digest("hex");
        const secondFingerprint = createHash("sha256")
          .update(secondPatch.stdout)
          .digest("hex");
        if (firstFingerprint !== secondFingerprint) {
          throw new GitDiffError(
            "DIFF_CHANGED",
            "Worktree files changed while their diff was being inspected",
          );
        }
        const patch =
          Buffer.byteLength(secondPatch.stdout) <= MAX_TOTAL_PATCH_BYTES &&
          files.length <= MAX_RENDERED_FILES
            ? secondPatch.stdout
            : patches.join("");
        return {
          ...summary,
          snapshotId: secondFingerprint,
          patch,
          truncated: omittedFiles.length > 0,
          omittedFiles,
        };
      }),
    );
  }
}

export async function createGitDiffInspector(
  options: { env?: NodeJS.ProcessEnv; runner?: ProcessRunner } = {},
): Promise<GitDiffInspector> {
  const env = options.env ?? process.env;
  const executable = await resolveExecutable("git", env.PATH);
  return new CommandGitDiffInspector(
    executable,
    env,
    options.runner ?? runProcess,
  );
}
