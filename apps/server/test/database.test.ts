import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createVerifiedBackup,
  MigrationRequiredError,
  openDatabase,
} from "../src/database.js";

const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);
const roots: string[] = [];
function temporaryDatabase(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-database-"));
  roots.push(root);
  return { root, path: join(root, "database.sqlite") };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("foundation database", () => {
  it("migrates a fresh private database and applies operational pragmas", async () => {
    const target = temporaryDatabase();
    const database = await openDatabase({
      path: target.path,
      migrationsDirectory,
    });
    expect(database.schemaVersion).toBe(8);
    expect(database.foundation.getSchemaVersion()).toBe(8);
    expect(
      database.sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
        )
        .get(),
    ).toBeTruthy();
    expect(database.foundation.getMetadata("application_version")).toBe(
      "0.1.0",
    );
    expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.sqlite.pragma("journal_mode", { simple: true })).toBe(
      "wal",
    );
    expect(database.sqlite.pragma("busy_timeout", { simple: true })).toBe(
      5_000,
    );
    database.close();
    database.close();
    expect(statSync(target.path).mode & 0o777).toBe(0o600);
  });

  it("backfills workspace order using the previous deterministic ordering", async () => {
    const target = temporaryDatabase();
    const sqlite = new BetterSqlite3(target.path);
    const migrationNames = [
      "0001_foundation.sql",
      "0002_workspaces.sql",
      "0003_worktrees.sql",
      "0004_workflow_status.sql",
      "0005_finalize_worktree_deletion.sql",
      "0006_fault_tolerant_worktree_removal.sql",
    ];
    for (const [index, name] of migrationNames.entries()) {
      const sql = readFileSync(join(migrationsDirectory, name), "utf8");
      sqlite.transaction(() => {
        sqlite.exec(sql);
        sqlite
          .prepare(
            "INSERT INTO migration_journal(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            index + 1,
            name,
            createHash("sha256").update(sql).digest("hex"),
            "2026-01-01T00:00:00.000Z",
          );
        sqlite.pragma(`user_version = ${index + 1}`);
      })();
    }
    const insert = sqlite.prepare(`
      INSERT INTO workspaces (
        id, name, slug, repository_path, git_common_dir, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [index, name] of [
      "Zebra",
      "Project 2",
      "alpha",
      "Project 10",
    ].entries()) {
      insert.run(
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        name,
        name.toLowerCase().replaceAll(" ", "-"),
        `/repo-${index}`,
        `/repo-${index}/.git`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    }
    sqlite.close();

    const database = await openDatabase({
      path: target.path,
      migrationsDirectory,
    });
    expect(
      database.sqlite
        .prepare("SELECT name FROM workspaces ORDER BY sort_order")
        .all(),
    ).toEqual([
      { name: "alpha" },
      { name: "Project 10" },
      { name: "Project 2" },
      { name: "Zebra" },
    ]);
    database.close();
  });

  it("enforces hexadecimal object IDs in worktree lifecycle rows", async () => {
    const target = temporaryDatabase();
    const database = await openDatabase({
      path: target.path,
      migrationsDirectory,
    });
    database.sqlite
      .prepare(
        `
        INSERT INTO workspaces (
          id, name, slug, repository_path, git_common_dir, created_at, updated_at
        ) VALUES (?, 'Workspace', 'workspace', '/repo', '/repo/.git', ?, ?)
      `,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
    expect(() =>
      database.sqlite
        .prepare(
          `
          INSERT INTO worktrees (
            id, workspace_id, name, slug, path, branch_ref, base_ref,
            base_commit, lifecycle, created_at, updated_at
          ) VALUES (?, ?, 'Feature', 'feature', '/managed/feature',
            'refs/heads/pi-dash/feature', 'HEAD', ?, 'creating', ?, ?)
        `,
        )
        .run(
          "22222222-2222-4222-8222-222222222222",
          "11111111-1111-4111-8111-111111111111",
          `a${"z".repeat(39)}`,
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ),
    ).toThrow();
    database.close();
  });

  it("migrates completed tombstones into operation receipts without retaining worktree rows", async () => {
    const target = temporaryDatabase();
    const sqlite = new BetterSqlite3(target.path);
    sqlite.pragma("foreign_keys = ON");
    const migrationNames = [
      "0001_foundation.sql",
      "0002_workspaces.sql",
      "0003_worktrees.sql",
      "0004_workflow_status.sql",
    ];
    for (const [index, name] of migrationNames.entries()) {
      const sql = readFileSync(join(migrationsDirectory, name), "utf8");
      sqlite.transaction(() => {
        sqlite.exec(sql);
        sqlite
          .prepare(
            "INSERT INTO migration_journal(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            index + 1,
            name,
            createHash("sha256").update(sql).digest("hex"),
            "2026-01-01T00:00:00.000Z",
          );
        sqlite.pragma(`user_version = ${index + 1}`);
      })();
    }
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const worktreeId = "22222222-2222-4222-8222-222222222222";
    const operationId = "33333333-3333-4333-8333-333333333333";
    const failedWorktreeId = "55555555-5555-4555-8555-555555555555";
    const failedOperationId = "66666666-6666-4666-8666-666666666666";
    const timestamp = "2026-01-01T00:00:00.000Z";
    sqlite
      .prepare(
        `
        INSERT INTO workspaces (
          id, name, slug, repository_path, git_common_dir, created_at, updated_at
        ) VALUES (?, 'Workspace', 'workspace', '/repo', '/repo/.git', ?, ?)
      `,
      )
      .run(workspaceId, timestamp, timestamp);
    sqlite
      .prepare(
        `
        INSERT INTO worktrees (
          id, workspace_id, name, slug, path, branch_ref, base_ref,
          base_commit, lifecycle, final_branch_tip, safety_target_commit,
          branch_deleted, created_at, updated_at
        ) VALUES (?, ?, 'Feature', 'feature', '/managed/feature',
          'refs/heads/pi-dash/feature', 'HEAD', ?, 'removed', ?, ?, 1, ?, ?)
      `,
      )
      .run(
        worktreeId,
        workspaceId,
        "a".repeat(40),
        "a".repeat(40),
        "c".repeat(40),
        timestamp,
        timestamp,
      );
    sqlite
      .prepare(
        `
        INSERT INTO worktrees (
          id, workspace_id, name, slug, path, branch_ref, base_ref,
          base_commit, lifecycle, final_branch_tip, safety_target_commit,
          branch_deleted, created_at, updated_at
        ) VALUES (?, ?, 'Failed receipt', 'failed-receipt', '/managed/failed-receipt',
          'refs/heads/pi-dash/failed-receipt', 'HEAD', ?, 'removed', ?, ?, 1, ?, ?)
      `,
      )
      .run(
        failedWorktreeId,
        workspaceId,
        "b".repeat(40),
        "b".repeat(40),
        "d".repeat(40),
        timestamp,
        timestamp,
      );
    sqlite
      .prepare(
        `
        INSERT INTO worktree_operations (
          id, idempotency_key, operation_type, workspace_id, worktree_id,
          request_hash, request_json, status, http_status, result_json,
          created_at, updated_at
        ) VALUES (?, ?, 'delete_branch', ?, ?, ?, ?, 'in_progress', NULL, NULL, ?, ?)
      `,
      )
      .run(
        operationId,
        "44444444-4444-4444-8444-444444444444",
        workspaceId,
        worktreeId,
        "f".repeat(64),
        JSON.stringify({
          id: worktreeId,
          expectedBranchTip: "a".repeat(40),
          safetyTargetCommit: "c".repeat(40),
        }),
        timestamp,
        timestamp,
      );
    sqlite
      .prepare(
        `
        INSERT INTO worktree_operations (
          id, idempotency_key, operation_type, workspace_id, worktree_id,
          request_hash, request_json, status, http_status, result_json,
          error_code, error_message, created_at, updated_at
        ) VALUES (?, ?, 'delete_branch', ?, ?, ?, ?, 'failed', 500, NULL,
          'BRANCH_CHANGED', 'Git completed before receipt finalization', ?, ?)
      `,
      )
      .run(
        failedOperationId,
        "77777777-7777-4777-8777-777777777777",
        workspaceId,
        failedWorktreeId,
        "e".repeat(64),
        JSON.stringify({
          id: failedWorktreeId,
          expectedBranchTip: "b".repeat(40),
          safetyTargetCommit: "d".repeat(40),
        }),
        timestamp,
        timestamp,
      );
    sqlite.close();

    const database = await openDatabase({
      path: target.path,
      migrationsDirectory,
    });
    expect(
      database.sqlite
        .prepare("SELECT count(*) FROM worktrees WHERE id IN (?, ?)")
        .pluck()
        .get(worktreeId, failedWorktreeId),
    ).toBe(0);
    expect(
      database.sqlite
        .prepare(
          "SELECT worktree_id FROM workflow_status WHERE worktree_id = ?",
        )
        .get(worktreeId),
    ).toBeUndefined();
    const operation = database.sqlite
      .prepare(
        "SELECT worktree_id, status, result_json FROM worktree_operations WHERE id = ?",
      )
      .get(operationId) as {
      worktree_id: string;
      status: string;
      result_json: string;
    };
    expect(operation.worktree_id).toBe(worktreeId);
    expect(operation.status).toBe("succeeded");
    expect(JSON.parse(operation.result_json)).toEqual({
      operationId,
      deleted: true,
      atomic: true,
      worktreeId,
      workspaceId,
    });
    const failedOperation = database.sqlite
      .prepare(
        "SELECT status, result_json FROM worktree_operations WHERE id = ?",
      )
      .get(failedOperationId) as { status: string; result_json: string };
    expect(failedOperation.status).toBe("succeeded");
    expect(JSON.parse(failedOperation.result_json)).toEqual({
      operationId: failedOperationId,
      deleted: true,
      atomic: true,
      worktreeId: failedWorktreeId,
      workspaceId,
    });
    expect(
      database.sqlite
        .prepare("PRAGMA table_info(worktrees)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).not.toEqual(
      expect.arrayContaining(["branch_deleted", "safety_target_commit"]),
    );
    database.sqlite
      .prepare("DELETE FROM workspaces WHERE id = ?")
      .run(workspaceId);
    expect(
      database.sqlite
        .prepare("SELECT count(*) FROM worktree_operations WHERE id IN (?, ?)")
        .pluck()
        .get(operationId, failedOperationId),
    ).toBe(0);
    database.close();
  });

  it("backs up an existing version-zero database before automatic migration", async () => {
    const target = temporaryDatabase();
    const legacy = new BetterSqlite3(target.path);
    legacy.exec(
      "CREATE TABLE legacy_marker(value TEXT); INSERT INTO legacy_marker VALUES ('before-migration')",
    );
    legacy.close();

    const database = await openDatabase({
      path: target.path,
      migrationsDirectory,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    expect(database.schemaVersion).toBe(8);
    expect(database.backupPaths).toHaveLength(8);
    const backup = new BetterSqlite3(database.backupPaths[0]!, {
      readonly: true,
    });
    expect(
      backup.prepare("SELECT value FROM legacy_marker").pluck().get(),
    ).toBe("before-migration");
    expect(backup.pragma("user_version", { simple: true })).toBe(0);
    backup.close();
    database.close();
  });

  it("creates an openable WAL-safe backup containing uncheckpointed writes", async () => {
    const target = temporaryDatabase();
    const sqlite = new BetterSqlite3(target.path);
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec(
      "CREATE TABLE sample(value TEXT NOT NULL); INSERT INTO sample VALUES ('from-wal')",
    );
    expect(existsSync(`${target.path}-wal`)).toBe(true);
    const backupPath = await createVerifiedBackup(
      sqlite,
      target.path,
      1,
      2,
      () => new Date("2026-01-01T00:00:00Z"),
    );
    const backup = new BetterSqlite3(backupPath, { readonly: true });
    expect(backup.prepare("SELECT value FROM sample").pluck().get()).toBe(
      "from-wal",
    );
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    backup.close();
    sqlite.close();
  });

  it("rolls back a failed migration transaction", async () => {
    const target = temporaryDatabase();
    const brokenMigrations = join(target.root, "migrations");
    mkdirSync(brokenMigrations);
    writeFileSync(
      join(brokenMigrations, "0001_broken.sql"),
      "CREATE TABLE partial(value TEXT); THIS IS NOT SQL;",
    );
    await expect(
      openDatabase({
        path: target.path,
        migrationsDirectory: brokenMigrations,
      }),
    ).rejects.toThrow();
    const sqlite = new BetterSqlite3(target.path);
    expect(
      sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'partial'",
        )
        .get(),
    ).toBeUndefined();
    expect(sqlite.pragma("user_version", { simple: true })).toBe(0);
    sqlite.close();
  });

  it("rejects a database newer than the application", async () => {
    const target = temporaryDatabase();
    const sqlite = new BetterSqlite3(target.path);
    sqlite.pragma("user_version = 99");
    sqlite.close();
    await expect(
      openDatabase({ path: target.path, migrationsDirectory }),
    ).rejects.toBeInstanceOf(MigrationRequiredError);
  });
});
