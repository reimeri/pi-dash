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

export const worktrees = sqliteTable(
  "worktrees",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    path: text("path").notNull(),
    branchRef: text("branch_ref").notNull(),
    baseRef: text("base_ref").notNull(),
    baseCommit: text("base_commit").notNull(),
    lifecycle: text("lifecycle", {
      enum: ["creating", "ready", "removing", "removed", "error"],
    }).notNull(),
    finalBranchTip: text("final_branch_tip"),
    safetyTargetCommit: text("safety_target_commit"),
    branchDeleted: integer("branch_deleted", { mode: "boolean" })
      .notNull()
      .default(false),
    health: text("health", {
      enum: ["healthy", "missing", "git_mismatch", "locked", "unknown"],
    })
      .notNull()
      .default("unknown"),
    dirty: integer("dirty", { mode: "boolean" }),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("worktrees_path_unique").on(table.path),
    index("worktrees_branch_ref_idx").on(table.branchRef),
    uniqueIndex("worktrees_workspace_slug_unique").on(
      table.workspaceId,
      table.slug,
    ),
    index("worktrees_workspace_lifecycle_idx").on(
      table.workspaceId,
      table.lifecycle,
      table.createdAt,
      table.id,
    ),
    index("worktrees_workspace_name_idx").on(
      table.workspaceId,
      table.name,
      table.createdAt,
      table.id,
    ),
  ],
);

export const worktreeOperations = sqliteTable(
  "worktree_operations",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    operationType: text("operation_type", {
      enum: ["create", "remove", "delete_branch"],
    }).notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    worktreeId: text("worktree_id").references(() => worktrees.id, {
      onDelete: "cascade",
    }),
    requestHash: text("request_hash").notNull(),
    requestJson: text("request_json").notNull(),
    status: text("status", {
      enum: ["in_progress", "succeeded", "failed"],
    }).notNull(),
    httpStatus: integer("http_status"),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("worktree_operations_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    index("worktree_operations_worktree_idx").on(
      table.worktreeId,
      table.createdAt,
      table.id,
    ),
    index("worktree_operations_workspace_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
  ],
);
