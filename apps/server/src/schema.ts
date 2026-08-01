import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const appMetadata = sqliteTable("app_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const migrationJournal = sqliteTable("migration_journal", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  checksum: text("checksum").notNull(),
  appliedAt: text("applied_at").notNull(),
});

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    repositoryPath: text("repository_path").notNull(),
    gitCommonDir: text("git_common_dir").notNull(),
    repositoryHealth: text("repository_health", {
      enum: ["healthy", "missing", "inaccessible", "not_git", "changed"],
    })
      .notNull()
      .default("healthy"),
    currentBranch: text("current_branch"),
    headCommit: text("head_commit"),
    checkedAt: text("checked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("workspaces_slug_unique").on(table.slug),
    uniqueIndex("workspaces_repository_path_unique").on(table.repositoryPath),
    index("workspaces_name_order_idx").on(
      table.name,
      table.createdAt,
      table.id,
    ),
    index("workspaces_git_common_dir_idx").on(table.gitCommonDir),
  ],
);
