import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepository } from "../../../tests/fixtures/git-repository.js";
import {
  createGitWorkspaceSynchronizer,
  GitWorkspaceSyncError,
} from "../src/git/git-workspace-sync.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(repository: string, name: string, content: string): string {
  writeFileSync(join(repository, name), content);
  git(repository, "add", "--", name);
  git(repository, "commit", "-m", `Update ${name}`);
  return git(repository, "rev-parse", "HEAD");
}

function remoteFixture(): {
  root: string;
  workspace: string;
  producer: string;
  remote: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-workspace-sync-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  const workspace = createGitRepository(root, "workspace");
  git(workspace, "remote", "add", "origin", remote);
  git(workspace, "push", "--set-upstream", "origin", "main");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  const producer = join(root, "producer");
  execFileSync("git", ["clone", remote, producer], { stdio: "ignore" });
  git(producer, "config", "user.name", "Pi Dash Tests");
  git(producer, "config", "user.email", "pi-dash@example.invalid");
  return { root, workspace, producer, remote };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("GitWorkspaceSynchronizer", () => {
  it("fetches and fast-forwards without repository hooks or fsmonitor commands", async () => {
    const { root, workspace, producer } = remoteFixture();
    const remoteCommit = commitFile(producer, "remote.txt", "remote\n");
    git(producer, "push", "origin", "main");
    const hookMarker = join(root, "hook-ran");
    const monitorMarker = join(root, "monitor-ran");
    const hook = join(workspace, ".git", "hooks", "post-merge");
    const monitor = join(root, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(hookMarker)}\n`);
    writeFileSync(
      monitor,
      `#!/bin/sh\ntouch ${JSON.stringify(monitorMarker)}\n`,
    );
    chmodSync(hook, 0o700);
    chmodSync(monitor, 0o700);
    git(workspace, "config", "core.fsmonitor", monitor);

    const synchronizer = await createGitWorkspaceSynchronizer();
    await expect(synchronizer.sync(workspace)).resolves.toEqual({
      headCommit: remoteCommit,
    });
    expect(git(workspace, "rev-parse", "HEAD")).toBe(remoteCommit);
    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(monitorMarker)).toBe(false);
    git(workspace, "config", "--unset", "core.fsmonitor");
    expect(git(workspace, "status", "--porcelain")).toBe("");
  });

  it("fetches the configured upstream even when the remote refspec excludes it", async () => {
    const { workspace, producer } = remoteFixture();
    git(
      workspace,
      "config",
      "--add",
      "remote.origin.fetch",
      "^refs/heads/main",
    );
    const remoteCommit = commitFile(producer, "remote.txt", "remote\n");
    git(producer, "push", "origin", "main");
    const synchronizer = await createGitWorkspaceSynchronizer();

    await expect(synchronizer.sync(workspace)).resolves.toEqual({
      headCommit: remoteCommit,
    });
    expect(git(workspace, "rev-parse", "refs/remotes/origin/main")).toBe(
      remoteCommit,
    );
  });

  it("succeeds without moving an already current branch", async () => {
    const { workspace } = remoteFixture();
    const headCommit = git(workspace, "rev-parse", "HEAD");
    const synchronizer = await createGitWorkspaceSynchronizer();

    await expect(synchronizer.sync(workspace)).resolves.toEqual({ headCommit });
  });

  it("inspects repositories with multiple linked worktrees", async () => {
    const { root, workspace } = remoteFixture();
    const linked = join(root, "linked");
    git(workspace, "worktree", "add", "-b", "linked", linked);
    const headCommit = git(workspace, "rev-parse", "HEAD");
    const synchronizer = await createGitWorkspaceSynchronizer();

    await expect(synchronizer.sync(workspace)).resolves.toEqual({ headCommit });
  });

  it("refuses tracked or untracked workspace changes before fetching", async () => {
    const { workspace, remote } = remoteFixture();
    writeFileSync(join(workspace, "untracked.txt"), "local\n");
    rmSync(remote, { recursive: true, force: true });
    const synchronizer = await createGitWorkspaceSynchronizer();

    await expect(synchronizer.sync(workspace)).rejects.toMatchObject({
      code: "WORKSPACE_SYNC_DIRTY",
    });
  });

  it("refuses repository-local executable Git configuration", async () => {
    const { root, workspace } = remoteFixture();
    const marker = join(root, "ssh-command-ran");
    const command = join(root, "ssh-command.sh");
    writeFileSync(command, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(command, 0o700);
    git(workspace, "config", "core.sshCommand", command);
    const synchronizer = await createGitWorkspaceSynchronizer();

    await expect(synchronizer.sync(workspace)).rejects.toMatchObject({
      code: "WORKSPACE_SYNC_FAILED",
      message: expect.stringContaining("repository-local executable"),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a branch without a remote upstream", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-workspace-sync-"));
    roots.push(root);
    const workspace = createGitRepository(root, "workspace");
    const synchronizer = await createGitWorkspaceSynchronizer();

    await expect(synchronizer.sync(workspace)).rejects.toMatchObject({
      code: "WORKSPACE_SYNC_NO_UPSTREAM",
    });
  });

  it("refuses detached, ahead, and diverged branches", async () => {
    const detached = remoteFixture();
    git(detached.workspace, "checkout", "--detach");
    const synchronizer = await createGitWorkspaceSynchronizer();
    await expect(synchronizer.sync(detached.workspace)).rejects.toMatchObject({
      code: "WORKSPACE_SYNC_DETACHED",
    });

    const ahead = remoteFixture();
    commitFile(ahead.workspace, "ahead.txt", "ahead\n");
    await expect(synchronizer.sync(ahead.workspace)).rejects.toMatchObject({
      code: "WORKSPACE_SYNC_AHEAD",
    });

    const diverged = remoteFixture();
    commitFile(diverged.workspace, "local.txt", "local\n");
    commitFile(diverged.producer, "remote.txt", "remote\n");
    git(diverged.producer, "push", "origin", "main");
    await expect(synchronizer.sync(diverged.workspace)).rejects.toMatchObject({
      code: "WORKSPACE_SYNC_DIVERGED",
    });
  });

  it("returns a stable error when fetch fails", async () => {
    const { workspace, remote } = remoteFixture();
    rmSync(remote, { recursive: true, force: true });
    const synchronizer = await createGitWorkspaceSynchronizer();

    await expect(synchronizer.sync(workspace)).rejects.toEqual(
      expect.objectContaining<Partial<GitWorkspaceSyncError>>({
        code: "WORKSPACE_SYNC_FAILED",
      }),
    );
  });
});
