import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { eq } from "drizzle-orm";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { APP_VERSION, CURRENT_SCHEMA_VERSION } from "@pi-dash/contracts";
import { appMetadata } from "./schema.js";
import * as schema from "./schema.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface FoundationRepository {
  getMetadata(key: string): string | undefined;
  getSchemaVersion(): number;
}

export interface DatabaseService {
  sqlite: BetterSqlite3.Database;
  orm: BetterSQLite3Database<typeof schema>;
  foundation: FoundationRepository;
  schemaVersion: number;
  backupPaths: string[];
  close(): void;
}

export class MigrationRequiredError extends Error {
  readonly code = "MIGRATION_REQUIRED";
}

function loadMigrations(directory: string): Migration[] {
  const migrations = readdirSync(directory)
    .filter((file) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(file))
    .map((file) => {
      const version = Number(file.slice(0, 4));
      const sql = readFileSync(resolve(directory, file), "utf8");
      return {
        version,
        name: basename(file),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    })
    .sort((left, right) => left.version - right.version);

  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected)
      throw new Error(
        `Expected migration ${expected}, found ${migration.version}`,
      );
  });
  if (migrations.length !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Migration set ends at ${migrations.length}; application expects ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  return migrations;
}

function verifyAppliedMigrations(
  database: BetterSqlite3.Database,
  migrations: Migration[],
  current: number,
): void {
  if (current === 0) return;
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'migration_journal'",
    )
    .get();
  if (!table)
    throw new MigrationRequiredError(
      "Database has a schema version but no migration journal",
    );
  const rows = database
    .prepare(
      "SELECT version, checksum FROM migration_journal WHERE version <= ? ORDER BY version",
    )
    .all(current) as Array<{ version: number; checksum: string }>;
  if (rows.length !== current)
    throw new MigrationRequiredError(
      "Database migration journal is incomplete",
    );
  for (const row of rows) {
    if (migrations[row.version - 1]?.checksum !== row.checksum) {
      throw new MigrationRequiredError(
        `Migration ${row.version} checksum does not match this application`,
      );
    }
  }
}

export async function createVerifiedBackup(
  database: BetterSqlite3.Database,
  databasePath: string,
  fromVersion: number,
  toVersion: number,
  now: () => Date,
): Promise<string> {
  const stamp = now().toISOString().replaceAll(":", "-");
  const path = `${databasePath}.backup-v${fromVersion}-to-v${toVersion}-${stamp}`;
  try {
    await database.backup(path);
    chmodSync(path, 0o600);
    const backup = new BetterSqlite3(path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const result = backup.pragma("integrity_check", { simple: true });
      if (result !== "ok")
        throw new Error(`SQLite integrity check returned ${String(result)}`);
    } finally {
      backup.close();
    }
    return path;
  } catch (error) {
    rmSync(path, { force: true });
    throw new Error(
      `Unable to create verified pre-migration backup: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

export async function openDatabase(options: {
  path: string;
  migrationsDirectory: string;
  now?: () => Date;
}): Promise<DatabaseService> {
  const requiresPreMigrationBackup =
    existsSync(options.path) && statSync(options.path).size > 0;
  const sqlite = new BetterSqlite3(options.path);
  chmodSync(options.path, 0o600);
  const backups: string[] = [];
  let closed = false;
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("journal_mode = WAL");
    const migrations = loadMigrations(options.migrationsDirectory);
    let current = sqlite.pragma("user_version", { simple: true }) as number;
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new MigrationRequiredError(
        `Database schema ${current} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    verifyAppliedMigrations(sqlite, migrations, current);

    for (const migration of migrations.filter(
      (candidate) => candidate.version > current,
    )) {
      if (requiresPreMigrationBackup) {
        backups.push(
          await createVerifiedBackup(
            sqlite,
            options.path,
            current,
            migration.version,
            options.now ?? (() => new Date()),
          ),
        );
      }
      const apply = sqlite.transaction(() => {
        sqlite.exec(migration.sql);
        sqlite
          .prepare(
            "INSERT INTO migration_journal(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            migration.version,
            migration.name,
            migration.checksum,
            (options.now ?? (() => new Date()))().toISOString(),
          );
        sqlite
          .prepare(
            "INSERT INTO app_metadata(key, value) VALUES ('application_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          )
          .run(APP_VERSION);
        sqlite.pragma(`user_version = ${migration.version}`);
      });
      apply();
      current = migration.version;
    }

    const orm = drizzle(sqlite, { schema });
    const foundation: FoundationRepository = {
      getMetadata(key) {
        return orm
          .select()
          .from(appMetadata)
          .where(eq(appMetadata.key, key))
          .get()?.value;
      },
      getSchemaVersion() {
        return sqlite.pragma("user_version", { simple: true }) as number;
      },
    };
    return {
      sqlite,
      orm,
      foundation,
      schemaVersion: current,
      backupPaths: backups,
      close() {
        if (closed) return;
        closed = true;
        sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
