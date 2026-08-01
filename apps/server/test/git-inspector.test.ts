import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepository } from "../../../tests/fixtures/git-repository.js";
import {
  createGitInspector,
  GitInspectionError,
} from "../src/git/git-inspector.js";
import { ProcessExecutionError } from "../src/process/safe-process.js";

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-git-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GitInspector", () => {
  it("canonicalizes a selected subdirectory and reads branch, HEAD, and common dir", async () => {
    const root = temporaryRoot();
    const repository = createGitRepository(root, " project \n");
    const nested = join(repository, "src", "nested");
    mkdirSync(nested, { recursive: true });
    const inspector = await createGitInspector();

    await expect(inspector.probe()).resolves.toBe(true);
    const result = await inspector.inspect(nested);
    expect(result.repositoryPath).toBe(repository);
    expect(result.gitCommonDir).toBe(join(repository, ".git"));
    expect(result.currentBranch).toBe("main");
    expect(result.headCommit).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("inspects a detached linked worktree with its shared common directory", async () => {
    const root = temporaryRoot();
    const repository = createGitRepository(root, "primary");
    const linked = join(root, "linked");
    execFileSync("git", ["worktree", "add", "--detach", linked, "HEAD"], {
      cwd: repository,
      stdio: "ignore",
    });
    const inspector = await createGitInspector();

    const result = await inspector.inspect(linked);
    expect(result.repositoryPath).toBe(linked);
    expect(result.gitCommonDir).toBe(join(repository, ".git"));
    expect(result.currentBranch).toBeNull();
    expect(result.headCommit).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it("supports unborn repositories and rejects non-Git directories", async () => {
    const root = temporaryRoot();
    const unborn = createGitRepository(root, "unborn", { commit: false });
    const plain = join(root, "plain");
    mkdirSync(plain);
    const inspector = await createGitInspector();

    const result = await inspector.inspect(unborn);
    expect(result.currentBranch).toBe("main");
    expect(result.headCommit).toBeNull();
    await expect(inspector.inspect(plain)).rejects.toMatchObject({
      code: "NOT_A_GIT_WORKTREE",
    });
  });

  it("reports missing paths and changed repository identity as degraded health", async () => {
    const root = temporaryRoot();
    const repository = createGitRepository(root);
    const alias = join(root, "repository-link");
    symlinkSync(repository, alias);
    const inspector = await createGitInspector();
    const inspected = await inspector.inspect(alias);
    expect(inspected.repositoryPath).toBe(repository);

    const changed = await inspector.inspectHealth(
      repository,
      join(root, "different-common-dir"),
    );
    expect(changed.health).toBe("changed");

    rmSync(repository, { recursive: true, force: true });
    const missing = await inspector.inspectHealth(
      repository,
      inspected.gitCommonDir,
    );
    expect(missing).toMatchObject({
      health: "missing",
      currentBranch: null,
      headCommit: null,
    });
  });

  it("rejects relative paths and maps inaccessible process cwd failures", async () => {
    const root = temporaryRoot();
    const repository = createGitRepository(root);
    const inspector = await createGitInspector();
    await expect(
      inspector.inspect("relative/repository"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const inaccessible = await createGitInspector({
      runner: async () => {
        const cause = Object.assign(new Error("permission denied"), {
          code: "EACCES",
        });
        throw new ProcessExecutionError("spawn", "Unable to start", cause);
      },
    });
    await expect(inaccessible.inspect(repository)).rejects.toMatchObject({
      code: "PATH_INACCESSIBLE",
    });
  });

  it("maps an unavailable executable to a stable error", async () => {
    const root = temporaryRoot();
    const repository = createGitRepository(root);
    const inspector = await createGitInspector({ env: { PATH: "" } });
    await expect(inspector.inspect(repository)).rejects.toEqual(
      expect.objectContaining<Partial<GitInspectionError>>({
        code: "GIT_UNAVAILABLE",
      }),
    );
  });
});
