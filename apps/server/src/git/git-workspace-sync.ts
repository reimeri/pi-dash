import { resolveExecutable } from "../process/executable.js";
import {
  ProcessExecutionError,
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../process/safe-process.js";

export type GitWorkspaceSyncErrorCode =
  | "GIT_UNAVAILABLE"
  | "GIT_TIMEOUT"
  | "WORKSPACE_SYNC_DETACHED"
  | "WORKSPACE_SYNC_NO_UPSTREAM"
  | "WORKSPACE_SYNC_DIRTY"
  | "WORKSPACE_SYNC_AHEAD"
  | "WORKSPACE_SYNC_DIVERGED"
  | "WORKSPACE_SYNC_FAILED";

export class GitWorkspaceSyncError extends Error {
  constructor(
    readonly code: GitWorkspaceSyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GitWorkspaceSyncError";
  }
}

export interface GitWorkspaceSyncResult {
  headCommit: string;
}

export interface GitWorkspaceSynchronizer {
  sync(path: string, signal?: AbortSignal): Promise<GitWorkspaceSyncResult>;
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

function output(result: ProcessResult): string {
  return result.stdout.replace(/\n$/, "");
}

function validRefValue(value: string): boolean {
  return (
    value.length > 0 && value.length <= 1024 && !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

class CommandGitWorkspaceSynchronizer implements GitWorkspaceSynchronizer {
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
      throw new GitWorkspaceSyncError("GIT_UNAVAILABLE", "Git is unavailable");
    }
    try {
      return await this.runner(
        this.executable,
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "submodule.recurse=false",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.file.allow=always",
          "-c",
          "protocol.git.allow=always",
          "-c",
          "protocol.http.allow=always",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.ssh.allow=always",
          ...args,
        ],
        {
          cwd,
          env: gitEnvironment(this.env),
          signal,
          timeoutMs,
          maxOutputBytes: 128 * 1024,
        },
      );
    } catch (error) {
      if (
        error instanceof ProcessExecutionError &&
        error.reason === "timeout"
      ) {
        throw new GitWorkspaceSyncError("GIT_TIMEOUT", "Git sync timed out");
      }
      if (
        error instanceof ProcessExecutionError &&
        error.reason === "aborted"
      ) {
        throw error;
      }
      if (error instanceof ProcessExecutionError && error.reason === "spawn") {
        throw new GitWorkspaceSyncError(
          "GIT_UNAVAILABLE",
          "Git could not be started",
        );
      }
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_FAILED",
        "Git returned too much or invalid output while syncing",
      );
    }
  }

  private async requireSafeConfiguration(
    path: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const inspectScope = async (scope: "--local" | "--worktree") => {
      const result = await this.git(
        ["config", scope, "--name-only", "--list", "-z"],
        path,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new GitWorkspaceSyncError(
          "WORKSPACE_SYNC_FAILED",
          "The workspace Git configuration could not be inspected",
        );
      }
      const unsafe = result.stdout
        .split("\0")
        .filter(Boolean)
        .map((key) => key.toLocaleLowerCase("en-US"))
        .find(
          (key) =>
            key === "core.sshcommand" ||
            key === "core.gitproxy" ||
            key === "credential.helper" ||
            (key.startsWith("credential.") && key.endsWith(".helper")) ||
            (key.startsWith("remote.") &&
              (key.endsWith(".vcs") || key.endsWith(".proxy"))),
        );
      if (unsafe) {
        throw new GitWorkspaceSyncError(
          "WORKSPACE_SYNC_FAILED",
          "Remove repository-local executable Git configuration before syncing",
        );
      }
    };

    await inspectScope("--local");
    const worktreeConfig = await this.git(
      [
        "config",
        "--local",
        "--type=bool",
        "--get",
        "extensions.worktreeConfig",
      ],
      path,
      signal,
    );
    if (worktreeConfig.exitCode === 1) return;
    if (worktreeConfig.exitCode !== 0) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_FAILED",
        "The workspace Git configuration could not be inspected",
      );
    }
    if (output(worktreeConfig) === "true") await inspectScope("--worktree");
  }

  private async branch(path: string, signal?: AbortSignal): Promise<string> {
    const result = await this.git(
      ["symbolic-ref", "--quiet", "HEAD"],
      path,
      signal,
    );
    const branch = output(result);
    if (result.exitCode !== 0 || !validRefValue(branch)) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_DETACHED",
        "Check out a branch before syncing this workspace",
      );
    }
    return branch;
  }

  private async upstream(
    path: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<{ ref: string; remote: string; remoteRef: string }> {
    const result = await this.git(
      [
        "for-each-ref",
        "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)",
        branch,
      ],
      path,
      signal,
    );
    const [ref = "", remote = "", remoteRef = ""] = output(result).split("\0");
    if (
      result.exitCode !== 0 ||
      !validRefValue(ref) ||
      !validRefValue(remote) ||
      !validRefValue(remoteRef) ||
      !remoteRef.startsWith("refs/heads/") ||
      remote === "."
    ) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_NO_UPSTREAM",
        "Configure a remote tracking branch before syncing this workspace",
      );
    }
    return { ref, remote, remoteRef };
  }

  private async commit(
    path: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.git(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      path,
      signal,
    );
    const commit = output(result);
    if (result.exitCode !== 0 || !OBJECT_ID.test(commit)) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_FAILED",
        "The workspace branch or its upstream does not resolve to a commit",
      );
    }
    return commit;
  }

  private async isAncestor(
    path: string,
    ancestor: string,
    descendant: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.git(
      ["merge-base", "--is-ancestor", ancestor, descendant],
      path,
      signal,
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitWorkspaceSyncError(
      "WORKSPACE_SYNC_FAILED",
      "The workspace branch relationship could not be determined",
    );
  }

  private async requireClean(
    path: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.git(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      path,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_FAILED",
        "The workspace checkout could not be inspected",
      );
    }
    if (result.stdout.length > 0) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_DIRTY",
        "Commit, stash, or remove local changes before syncing this workspace",
      );
    }
  }

  async sync(
    path: string,
    signal?: AbortSignal,
  ): Promise<GitWorkspaceSyncResult> {
    await this.requireSafeConfiguration(path, signal);
    const initialBranch = await this.branch(path, signal);
    const initialUpstream = await this.upstream(path, initialBranch, signal);
    await this.requireClean(path, signal);
    const fetch = await this.git(
      [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--",
        initialUpstream.remote,
        `+${initialUpstream.remoteRef}:${initialUpstream.ref}`,
      ],
      path,
      signal,
      60_000,
    );
    if (fetch.exitCode !== 0) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_FAILED",
        "The workspace upstream could not be fetched",
      );
    }

    const branch = await this.branch(path, signal);
    const upstream = await this.upstream(path, branch, signal);
    if (
      branch !== initialBranch ||
      upstream.ref !== initialUpstream.ref ||
      upstream.remote !== initialUpstream.remote ||
      upstream.remoteRef !== initialUpstream.remoteRef
    ) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_FAILED",
        "The workspace branch configuration changed while syncing",
      );
    }

    await this.requireClean(path, signal);
    const [headCommit, upstreamCommit] = await Promise.all([
      this.commit(path, "HEAD", signal),
      this.commit(path, upstream.ref, signal),
    ]);
    if (headCommit === upstreamCommit) return { headCommit };

    if (!(await this.isAncestor(path, headCommit, upstreamCommit, signal))) {
      if (await this.isAncestor(path, upstreamCommit, headCommit, signal)) {
        throw new GitWorkspaceSyncError(
          "WORKSPACE_SYNC_AHEAD",
          "The workspace branch is ahead of its upstream and was not changed",
        );
      }
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_DIVERGED",
        "The workspace branch has diverged from its upstream; reconcile it manually",
      );
    }

    const merge = await this.git(
      ["merge", "--ff-only", "--no-edit", upstreamCommit],
      path,
      signal,
      30_000,
    );
    if (merge.exitCode !== 0) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_FAILED",
        "The workspace branch could not be fast-forwarded",
      );
    }
    const [finalBranch, finalCommit] = await Promise.all([
      this.branch(path),
      this.commit(path, "HEAD"),
    ]);
    await this.requireClean(path);
    if (finalBranch !== branch || finalCommit !== upstreamCommit) {
      throw new GitWorkspaceSyncError(
        "WORKSPACE_SYNC_FAILED",
        "The workspace changed unexpectedly while syncing",
      );
    }
    return { headCommit: finalCommit };
  }
}

export async function createGitWorkspaceSynchronizer(
  options: {
    env?: NodeJS.ProcessEnv;
    runner?: ProcessRunner;
  } = {},
): Promise<GitWorkspaceSynchronizer> {
  const env = options.env ?? process.env;
  return new CommandGitWorkspaceSynchronizer(
    await resolveExecutable("git", env.PATH),
    env,
    options.runner ?? runProcess,
  );
}
