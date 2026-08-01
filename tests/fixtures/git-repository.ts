import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createGitRepository(
  parent: string,
  name = "repository",
  options: { commit?: boolean } = { commit: true },
): string {
  const repository = join(parent, name);
  mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", repository], {
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Pi Dash Tests"], {
    cwd: repository,
  });
  execFileSync("git", ["config", "user.email", "pi-dash@example.invalid"], {
    cwd: repository,
  });
  if (options.commit !== false) {
    writeFileSync(join(repository, "README.md"), "# Test repository\n");
    execFileSync("git", ["add", "--", "README.md"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "Initial commit"], {
      cwd: repository,
      stdio: "ignore",
    });
  }
  return repository;
}
