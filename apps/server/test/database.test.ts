import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
    expect(database.schemaVersion).toBe(1);
    expect(database.foundation.getSchemaVersion()).toBe(1);
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
    expect(database.schemaVersion).toBe(1);
    expect(database.backupPaths).toHaveLength(1);
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
