import type BetterSqlite3 from "better-sqlite3";
import type {
  ApiErrorCode,
  WorktreeHealth,
  WorktreeLifecycle,
} from "@pi-dash/contracts";

export interface WorktreeRecord {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  path: string;
  branchRef: string;
  baseRef: string;
  baseCommit: string;
  lifecycle: WorktreeLifecycle;
  finalBranchTip: string | null;
  safetyTargetCommit: string | null;
  branchDeleted: boolean;
  health: WorktreeHealth;
  dirty: boolean | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorktreeOperationType = "create" | "remove" | "delete_branch";
export type WorktreeOperationStatus = "in_progress" | "succeeded" | "failed";

export interface WorktreeOperationRecord {
  id: string;
  idempotencyKey: string;
  operationType: WorktreeOperationType;
  workspaceId: string;
  worktreeId: string | null;
  requestHash: string;
  requestJson: string;
  status: WorktreeOperationStatus;
  httpStatus: number | null;
  resultJson: string | null;
  errorCode: ApiErrorCode | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorktreeRow {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  path: string;
  branch_ref: string;
  base_ref: string;
  base_commit: string;
  lifecycle: WorktreeLifecycle;
  final_branch_tip: string | null;
  safety_target_commit: string | null;
  branch_deleted: number;
  health: WorktreeHealth;
  dirty: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  id: string;
  idempotency_key: string;
  operation_type: WorktreeOperationType;
  workspace_id: string;
  worktree_id: string | null;
  request_hash: string;
  request_json: string;
  status: WorktreeOperationStatus;
  http_status: number | null;
  result_json: string | null;
  error_code: ApiErrorCode | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const WORKTREE_COLUMNS = `
  id, workspace_id, name, slug, path, branch_ref, base_ref, base_commit,
  lifecycle, final_branch_tip, safety_target_commit, branch_deleted, health,
  dirty, last_error_code, last_error_message, created_at, updated_at
`;
const OPERATION_COLUMNS = `
  id, idempotency_key, operation_type, workspace_id, worktree_id, request_hash,
  request_json, status, http_status, result_json, error_code, error_message,
  created_at, updated_at
`;

function worktreeFromRow(row: WorktreeRow): WorktreeRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    slug: row.slug,
    path: row.path,
    branchRef: row.branch_ref,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    lifecycle: row.lifecycle,
    finalBranchTip: row.final_branch_tip,
    safetyTargetCommit: row.safety_target_commit,
    branchDeleted: row.branch_deleted === 1,
    health: row.health,
    dirty: row.dirty === null ? null : row.dirty === 1,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function operationFromRow(row: OperationRow): WorktreeOperationRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    operationType: row.operation_type,
    workspaceId: row.workspace_id,
    worktreeId: row.worktree_id,
    requestHash: row.request_hash,
    requestJson: row.request_json,
    status: row.status,
    httpStatus: row.http_status,
    resultJson: row.result_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WorktreeRepository {
  list(workspaceId: string): WorktreeRecord[];
  listAll(): WorktreeRecord[];
  get(id: string): WorktreeRecord | undefined;
  slugExists(workspaceId: string, slug: string): boolean;
  pathExists(path: string): boolean;
  branchExistsInCommonDir(gitCommonDir: string, branchRef: string): boolean;
  create(record: WorktreeRecord): WorktreeRecord;
  updateState(
    id: string,
    update: {
      lifecycle?: WorktreeLifecycle;
      finalBranchTip?: string | null;
      safetyTargetCommit?: string | null;
      branchDeleted?: boolean;
      health?: WorktreeHealth;
      dirty?: boolean | null;
      lastErrorCode?: string | null;
      lastErrorMessage?: string | null;
      updatedAt: string;
    },
  ): WorktreeRecord | undefined;
  compareAndSetLifecycle(
    id: string,
    expected: WorktreeLifecycle,
    next: WorktreeLifecycle,
    updatedAt: string,
  ): WorktreeRecord | undefined;
  activeCount(workspaceId: string): number;
  findOperation(idempotencyKey: string): WorktreeOperationRecord | undefined;
  listInProgress(workspaceId: string): WorktreeOperationRecord[];
  createOperation(record: WorktreeOperationRecord): WorktreeOperationRecord;
  updateOperationWorktree(
    id: string,
    worktreeId: string,
    updatedAt: string,
  ): void;
  completeOperation(
    id: string,
    httpStatus: number,
    resultJson: string,
    updatedAt: string,
  ): void;
  failOperation(
    id: string,
    httpStatus: number,
    code: ApiErrorCode,
    message: string,
    updatedAt: string,
  ): void;
  transaction<T>(operation: () => T): T;
}

export function createWorktreeRepository(
  sqlite: BetterSqlite3.Database,
): WorktreeRepository {
  const list = sqlite.prepare(
    `SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE workspace_id = ? ORDER BY created_at, id`,
  );
  const listAll = sqlite.prepare(
    `SELECT ${WORKTREE_COLUMNS} FROM worktrees ORDER BY workspace_id, created_at, id`,
  );
  const get = sqlite.prepare(
    `SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE id = ?`,
  );
  const insert = sqlite.prepare(`
    INSERT INTO worktrees (
      id, workspace_id, name, slug, path, branch_ref, base_ref, base_commit,
      lifecycle, final_branch_tip, safety_target_commit, branch_deleted, health,
      dirty, last_error_code, last_error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const operationGet = sqlite.prepare(
    `SELECT ${OPERATION_COLUMNS} FROM worktree_operations WHERE idempotency_key = ?`,
  );
  const operationInsert = sqlite.prepare(`
    INSERT INTO worktree_operations (
      id, idempotency_key, operation_type, workspace_id, worktree_id,
      request_hash, request_json, status, http_status, result_json, error_code,
      error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const repository: WorktreeRepository = {
    list(workspaceId) {
      return (list.all(workspaceId) as WorktreeRow[]).map(worktreeFromRow);
    },
    listAll() {
      return (listAll.all() as WorktreeRow[]).map(worktreeFromRow);
    },
    get(id) {
      const row = get.get(id) as WorktreeRow | undefined;
      return row ? worktreeFromRow(row) : undefined;
    },
    slugExists(workspaceId, slug) {
      return Boolean(
        sqlite
          .prepare(
            "SELECT 1 AS present FROM worktrees WHERE workspace_id = ? AND slug = ?",
          )
          .get(workspaceId, slug),
      );
    },
    pathExists(path) {
      return Boolean(
        sqlite
          .prepare("SELECT 1 AS present FROM worktrees WHERE path = ?")
          .get(path),
      );
    },
    branchExistsInCommonDir(gitCommonDir, branchRef) {
      return Boolean(
        sqlite
          .prepare(
            `
            SELECT 1 AS present
            FROM worktrees
            INNER JOIN workspaces ON workspaces.id = worktrees.workspace_id
            WHERE workspaces.git_common_dir = ? AND worktrees.branch_ref = ?
            LIMIT 1
          `,
          )
          .get(gitCommonDir, branchRef),
      );
    },
    create(record) {
      insert.run(
        record.id,
        record.workspaceId,
        record.name,
        record.slug,
        record.path,
        record.branchRef,
        record.baseRef,
        record.baseCommit,
        record.lifecycle,
        record.finalBranchTip,
        record.safetyTargetCommit,
        record.branchDeleted ? 1 : 0,
        record.health,
        record.dirty === null ? null : record.dirty ? 1 : 0,
        record.lastErrorCode,
        record.lastErrorMessage,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    },
    updateState(id, update) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if ("lifecycle" in update) set("lifecycle", update.lifecycle);
      if ("finalBranchTip" in update)
        set("final_branch_tip", update.finalBranchTip);
      if ("safetyTargetCommit" in update)
        set("safety_target_commit", update.safetyTargetCommit);
      if ("branchDeleted" in update)
        set("branch_deleted", update.branchDeleted ? 1 : 0);
      if ("health" in update) set("health", update.health);
      if ("dirty" in update)
        set("dirty", update.dirty === null ? null : update.dirty ? 1 : 0);
      if ("lastErrorCode" in update)
        set("last_error_code", update.lastErrorCode);
      if ("lastErrorMessage" in update)
        set("last_error_message", update.lastErrorMessage);
      set("updated_at", update.updatedAt);
      const result = sqlite
        .prepare(`UPDATE worktrees SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values, id);
      return result.changes > 0 ? repository.get(id) : undefined;
    },
    compareAndSetLifecycle(id, expected, next, updatedAt) {
      const result = sqlite
        .prepare(
          "UPDATE worktrees SET lifecycle = ?, updated_at = ? WHERE id = ? AND lifecycle = ?",
        )
        .run(next, updatedAt, id, expected);
      return result.changes > 0 ? repository.get(id) : undefined;
    },
    activeCount(workspaceId) {
      const row = sqlite
        .prepare(
          "SELECT count(*) AS count FROM worktrees WHERE workspace_id = ? AND lifecycle <> 'removed'",
        )
        .get(workspaceId) as { count: number };
      return row.count;
    },
    findOperation(idempotencyKey) {
      const row = operationGet.get(idempotencyKey) as OperationRow | undefined;
      return row ? operationFromRow(row) : undefined;
    },
    listInProgress(workspaceId) {
      return (
        sqlite
          .prepare(
            `SELECT ${OPERATION_COLUMNS} FROM worktree_operations WHERE workspace_id = ? AND status = 'in_progress' ORDER BY created_at, id`,
          )
          .all(workspaceId) as OperationRow[]
      ).map(operationFromRow);
    },
    createOperation(record) {
      operationInsert.run(
        record.id,
        record.idempotencyKey,
        record.operationType,
        record.workspaceId,
        record.worktreeId,
        record.requestHash,
        record.requestJson,
        record.status,
        record.httpStatus,
        record.resultJson,
        record.errorCode,
        record.errorMessage,
        record.createdAt,
        record.updatedAt,
      );
      return record;
    },
    updateOperationWorktree(id, worktreeId, updatedAt) {
      sqlite
        .prepare(
          "UPDATE worktree_operations SET worktree_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(worktreeId, updatedAt, id);
    },
    completeOperation(id, httpStatus, resultJson, updatedAt) {
      sqlite
        .prepare(
          `
          UPDATE worktree_operations
          SET status = 'succeeded', http_status = ?, result_json = ?,
              error_code = NULL, error_message = NULL, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(httpStatus, resultJson, updatedAt, id);
    },
    failOperation(id, httpStatus, code, message, updatedAt) {
      sqlite
        .prepare(
          `
          UPDATE worktree_operations
          SET status = 'failed', http_status = ?, result_json = NULL,
              error_code = ?, error_message = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(httpStatus, code, message, updatedAt, id);
    },
    transaction<T>(operation: () => T): T {
      return sqlite.transaction(operation)();
    },
  };
  return repository;
}
