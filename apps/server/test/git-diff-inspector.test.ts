import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitDiffInspector,
  GitDiffError,
} from "../src/git/git-diff-inspector.js";
import { runProcess, type ProcessRunner } from "../src/process/safe-process.js";
import { createGitRepository } from "../../../tests/fixtures/git-repository.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; repository: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-diff-test-"));
  roots.push(root);
  return { root, repository: createGitRepository(root) };
}

describe("GitDiffInspector", () => {
  it("combines staged, unstaged, and untracked files against worktree HEAD", async () => {
    const { repository } = fixture();
    const inspector = await createGitDiffInspector();
    expect(await inspector.summary(repository)).toMatchObject({
      hasChanges: false,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    });

    writeFileSync(join(repository, "README.md"), "# Staged\n");
    execFileSync("git", ["add", "--", "README.md"], { cwd: repository });
    writeFileSync(join(repository, "README.md"), "# Changed\nsecond\n");
    writeFileSync(join(repository, "new file.ts"), "one\ntwo\n");
    writeFileSync(join(repository, "empty.txt"), "");
    writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repository, "ignored.txt"), "secret\n");

    const summary = await inspector.summary(repository);
    expect(summary).toMatchObject({
      hasChanges: true,
      filesChanged: 4,
      additions: 5,
      deletions: 1,
      binaryFiles: 0,
    });

    const snapshot = await inspector.snapshot(repository);
    expect(snapshot).toMatchObject({
      hasChanges: true,
      filesChanged: 4,
      additions: 5,
      deletions: 1,
      truncated: false,
      omittedFiles: [],
    });
    expect(snapshot.patch).toContain("diff --git a/README.md b/README.md");
    expect(snapshot.patch).toContain("diff --git a/empty.txt b/empty.txt");
    expect(snapshot.patch).toContain("diff --git a/new file.ts b/new file.ts");
    expect(snapshot.patch).not.toContain("diff --git a/ignored.txt");
    expect(snapshot.snapshotId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps rename metadata and special filenames in a complete file patch", async () => {
    const { repository } = fixture();
    const inspector = await createGitDiffInspector();
    execFileSync("git", ["mv", "README.md", "renamed file.md"], {
      cwd: repository,
    });

    const snapshot = await inspector.snapshot(repository);
    expect(snapshot).toMatchObject({
      hasChanges: true,
      filesChanged: 1,
      additions: 0,
      deletions: 0,
      truncated: false,
    });
    expect(snapshot.patch).toContain("similarity index 100%");
    expect(snapshot.patch).toContain("rename from README.md");
    expect(snapshot.patch).toContain("rename to renamed file.md");
  });

  it("limits the number of rendered files even for a small aggregate patch", async () => {
    const { repository } = fixture();
    for (let index = 0; index < 201; index += 1) {
      writeFileSync(join(repository, `tiny-${index}.txt`), `${index}\n`);
    }
    const inspector = await createGitDiffInspector();

    const snapshot = await inspector.snapshot(repository);
    expect(snapshot).toMatchObject({
      hasChanges: true,
      filesChanged: 201,
      truncated: true,
    });
    expect(snapshot.omittedFiles).toHaveLength(1);
    expect(snapshot.omittedFiles[0]?.reason).toBe("file-limit");
    expect(snapshot.patch.match(/^diff --git /gm)).toHaveLength(200);
  });

  it("includes submodule changes even when repository config ignores them", async () => {
    const { root, repository } = fixture();
    const submoduleOrigin = createGitRepository(root, "submodule-origin");
    execFileSync(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        submoduleOrigin,
        "vendor/submodule",
      ],
      { cwd: repository, stdio: "ignore" },
    );
    execFileSync("git", ["commit", "-am", "Add submodule"], {
      cwd: repository,
      stdio: "ignore",
    });
    const submodule = join(repository, "vendor/submodule");
    execFileSync("git", ["config", "user.name", "Pi Dash Tests"], {
      cwd: submodule,
    });
    execFileSync("git", ["config", "user.email", "pi-dash@example.invalid"], {
      cwd: submodule,
    });
    writeFileSync(join(submodule, "next.txt"), "next\n");
    execFileSync("git", ["add", "--", "next.txt"], { cwd: submodule });
    execFileSync("git", ["commit", "-m", "Advance submodule"], {
      cwd: submodule,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "diff.ignoreSubmodules", "all"], {
      cwd: repository,
    });
    const inspector = await createGitDiffInspector();

    const snapshot = await inspector.snapshot(repository);
    expect(snapshot).toMatchObject({ hasChanges: true, filesChanged: 1 });
    expect(snapshot.patch).toContain("Subproject commit");
  });

  it("rejects a snapshot when files change during inspection", async () => {
    const { repository } = fixture();
    writeFileSync(join(repository, "changing.txt"), "first\n");
    let wholePatchCalls = 0;
    const runner: ProcessRunner = async (executable, args, options) => {
      const result = await runProcess(executable, args, options);
      if (
        args.includes("--patch") &&
        args.at(-1) === "--" &&
        wholePatchCalls++ === 0
      ) {
        writeFileSync(join(repository, "changing.txt"), "second\n");
      }
      return result;
    };
    const inspector = await createGitDiffInspector({ runner });

    await expect(inspector.snapshot(repository)).rejects.toEqual(
      expect.objectContaining<Partial<GitDiffError>>({ code: "DIFF_CHANGED" }),
    );
  });

  it("reports binary-only changes without running configured diff helpers", async () => {
    const { root, repository } = fixture();
    const inspector = await createGitDiffInspector();
    const marker = join(root, "external-diff-ran");
    const helper = join(root, "external-diff.sh");
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`);
    execFileSync("chmod", ["+x", helper]);
    execFileSync("git", ["config", "diff.external", helper], {
      cwd: repository,
    });
    writeFileSync(join(repository, "binary.dat"), Buffer.from([0, 1, 2, 0, 3]));

    const snapshot = await inspector.snapshot(repository);
    expect(snapshot).toMatchObject({
      hasChanges: true,
      filesChanged: 1,
      additions: 0,
      deletions: 0,
      binaryFiles: 1,
    });
    expect(snapshot.patch).toContain("Binary files");
    expect(existsSync(marker)).toBe(false);
  });
});
