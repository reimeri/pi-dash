ALTER TABLE worktree_operations RENAME TO worktree_operations_old;

CREATE TABLE worktree_operations (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('create', 'remove', 'delete_branch')),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  worktree_id TEXT,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed')),
  http_status INTEGER,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO worktree_operations (
  id, idempotency_key, operation_type, workspace_id, worktree_id,
  request_hash, request_json, status, http_status, result_json, error_code,
  error_message, created_at, updated_at
)
SELECT
  id, idempotency_key, operation_type, workspace_id, worktree_id,
  request_hash, request_json, status, http_status, result_json, error_code,
  error_message, created_at, updated_at
FROM worktree_operations_old;

DROP TABLE worktree_operations_old;

CREATE INDEX worktree_operations_worktree_idx
  ON worktree_operations (worktree_id, created_at, id);
CREATE INDEX worktree_operations_workspace_idx
  ON worktree_operations (workspace_id, created_at, id);

UPDATE worktree_operations
SET
  status = 'succeeded',
  http_status = 200,
  error_code = NULL,
  error_message = NULL,
  updated_at = (
    SELECT updated_at FROM worktrees WHERE worktrees.id = worktree_operations.worktree_id
  )
WHERE
  operation_type = 'delete_branch'
  AND status = 'in_progress'
  AND EXISTS (
    SELECT 1
    FROM worktrees
    WHERE
      worktrees.id = worktree_operations.worktree_id
      AND worktrees.lifecycle = 'removed'
      AND worktrees.branch_deleted = 1
      AND CASE
        WHEN json_valid(worktree_operations.request_json)
          THEN json_extract(worktree_operations.request_json, '$.expectedBranchTip')
        ELSE NULL
      END = worktrees.final_branch_tip
      AND CASE
        WHEN json_valid(worktree_operations.request_json)
          THEN json_extract(worktree_operations.request_json, '$.safetyTargetCommit')
        ELSE NULL
      END = worktrees.safety_target_commit
  );

UPDATE worktree_operations
SET
  status = 'succeeded',
  http_status = 200,
  error_code = NULL,
  error_message = NULL,
  updated_at = (
    SELECT updated_at FROM worktrees WHERE worktrees.id = worktree_operations.worktree_id
  )
WHERE id IN (
  SELECT (
    SELECT candidate.id
    FROM worktree_operations AS candidate
    WHERE
      candidate.worktree_id = worktrees.id
      AND candidate.operation_type = 'delete_branch'
      AND candidate.status = 'failed'
      AND CASE
        WHEN json_valid(candidate.request_json)
          THEN json_extract(candidate.request_json, '$.expectedBranchTip')
        ELSE NULL
      END = worktrees.final_branch_tip
      AND CASE
        WHEN json_valid(candidate.request_json)
          THEN json_extract(candidate.request_json, '$.safetyTargetCommit')
        ELSE NULL
      END = worktrees.safety_target_commit
    ORDER BY
      CASE
        WHEN candidate.error_code = 'BRANCH_CHANGED' AND candidate.http_status = 500 THEN 0
        ELSE 1
      END,
      candidate.updated_at DESC,
      candidate.id DESC
    LIMIT 1
  )
  FROM worktrees
  WHERE
    worktrees.lifecycle = 'removed'
    AND worktrees.branch_deleted = 1
    AND NOT EXISTS (
      SELECT 1
      FROM worktree_operations AS completed
      WHERE
        completed.worktree_id = worktrees.id
        AND completed.operation_type = 'delete_branch'
        AND completed.status = 'succeeded'
    )
);

UPDATE worktree_operations
SET result_json = json_object(
  'operationId', id,
  'deleted', json('true'),
  'atomic', json('true'),
  'worktreeId', worktree_id,
  'workspaceId', workspace_id
)
WHERE operation_type = 'delete_branch' AND status = 'succeeded';

UPDATE worktree_operations
SET result_json = json_remove(
  result_json,
  '$.worktree.safetyTargetCommit',
  '$.worktree.branchDeleted'
)
WHERE
  operation_type IN ('create', 'remove')
  AND status = 'succeeded'
  AND result_json IS NOT NULL;

CREATE TEMP TABLE worktree_deletion_migration_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO worktree_deletion_migration_guard (invalid_count)
SELECT count(*)
FROM worktrees
WHERE
  worktrees.lifecycle = 'removed'
  AND worktrees.branch_deleted = 1
  AND NOT EXISTS (
    SELECT 1
    FROM worktree_operations AS completed
    WHERE
      completed.worktree_id = worktrees.id
      AND completed.operation_type = 'delete_branch'
      AND completed.status = 'succeeded'
      AND CASE
        WHEN json_valid(completed.request_json)
          THEN json_extract(completed.request_json, '$.expectedBranchTip')
        ELSE NULL
      END = worktrees.final_branch_tip
      AND CASE
        WHEN json_valid(completed.request_json)
          THEN json_extract(completed.request_json, '$.safetyTargetCommit')
        ELSE NULL
      END = worktrees.safety_target_commit
  );

DROP TABLE worktree_deletion_migration_guard;

DELETE FROM worktrees
WHERE lifecycle = 'removed' AND branch_deleted = 1;

ALTER TABLE worktrees DROP COLUMN safety_target_commit;
ALTER TABLE worktrees DROP COLUMN branch_deleted;
