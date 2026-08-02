import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRepository } from "../../../tests/fixtures/git-repository.js";
import { createGitInspector } from "../src/git/git-inspector.js";
import { openDatabase, type DatabaseService } from "../src/database.js";
import { createWorkspaceRepository } from "../src/workspaces/workspace-repository.js";
import {
  createWorkspaceService,
  workspaceSlugBase,
  type WorkspaceService,
} from "../src/workspaces/workspace-service.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);
const resources: Array<{ root: string; database: DatabaseService }> = [];

async function fixture(): Promise<{
  root: string;
  database: DatabaseService;
  service: WorkspaceService;
}> {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-workspace-"));
  const database = await openDatabase({
    path: join(root, "database.sqlite"),
    migrationsDirectory,
  });
  const service = createWorkspaceService({
    repository: createWorkspaceRepository(database.sqlite),
    git: await createGitInspector({
      now: () => new Date("2026-02-03T04:05:06.000Z"),
    }),
    now: () => new Date("2026-02-03T04:05:06.000Z"),
  });
  resources.push({ root, database });
  return { root, database, service };
}

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ root, database }) => {
      database.close();
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("WorkspaceService", () => {
  it("registers canonical repositories once, including symlink aliases", async () => {
    const { root, service } = await fixture();
    const repository = createGitRepository(root, "project");
    const alias = join(root, "alias");
    symlinkSync(repository, alias);

    const created = await service.create({ path: alias, name: " Project " });
    expect(created).toMatchObject({
      name: "Project",
      slug: "project",
      repositoryPath: repository,
      repository: { health: "healthy", currentBranch: "main" },
      worktreeCount: 0,
    });
    await expect(
      service.create({ path: repository, name: "Duplicate" }),
    ).rejects.toMatchObject({
      code: "WORKSPACE_EXISTS",
      details: { workspaceId: created.id, workspaceName: "Project" },
    });
    expect(service.list()).toHaveLength(1);
  });

  it("uses unique immutable slugs and deterministic name ordering", async () => {
    const { root, service } = await fixture();
    const firstRepository = createGitRepository(root, "first");
    const secondRepository = createGitRepository(root, "second");
    const first = await service.create({
      path: firstRepository,
      name: "Pi Däsh",
    });
    const second = await service.create({
      path: secondRepository,
      name: "Pi Dash",
    });
    expect(first.slug).toBe("pi-dash");
    expect(second.slug).toBe("pi-dash-2");

    const renamed = service.rename(first.id, "Zebra");
    expect(renamed.slug).toBe("pi-dash");
    expect(service.list().map((workspace) => workspace.name)).toEqual([
      "Pi Dash",
      "Zebra",
    ]);
    expect(workspaceSlugBase("你好")).toBe("workspace");
  });

  it("persists degraded missing health and removes metadata without repository files", async () => {
    const { root, service } = await fixture();
    const repository = createGitRepository(root, "movable");
    const created = await service.create({ path: repository, name: "Movable" });
    rmSync(repository, { recursive: true, force: true });

    const degraded = await service.refresh(created.id);
    expect(degraded.repository).toMatchObject({
      health: "missing",
      currentBranch: null,
      headCommit: null,
      checkedAt: "2026-02-03T04:05:06.000Z",
    });
    expect(service.get(created.id).repository.health).toBe("missing");
    service.remove(created.id);
    expect(service.list()).toEqual([]);
  });

  it("blocks removal when future managed worktree rows exist", async () => {
    const { root, database, service } = await fixture();
    const repository = createGitRepository(root, "project");
    const created = await service.create({ path: repository, name: "Project" });
    database.sqlite
      .prepare(
        `
        INSERT INTO worktrees (
          id, workspace_id, name, slug, path, branch_ref, base_ref, base_commit,
          lifecycle, health, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', 'healthy', ?, ?)
      `,
      )
      .run(
        "worktree-1",
        created.id,
        "Feature",
        "feature",
        `${root}/managed-feature`,
        "refs/heads/pi-dash/feature",
        "HEAD",
        "a".repeat(40),
        "2026-02-03T04:05:06.000Z",
        "2026-02-03T04:05:06.000Z",
      );

    expect(service.get(created.id).worktreeCount).toBe(1);
    expect(() => service.remove(created.id)).toThrow(
      expect.objectContaining({ code: "WORKSPACE_HAS_WORKTREES" }),
    );
  });
});
