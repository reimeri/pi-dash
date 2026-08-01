CREATE TABLE worktrees (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  slug TEXT NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 72
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '-%'
    AND slug NOT LIKE '%-'
    AND slug NOT LIKE '%--%'
  ),
  path TEXT NOT NULL UNIQUE,
  branch_ref TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_commit TEXT NOT NULL CHECK (
    length(base_commit) IN (40, 64)
    AND base_commit NOT GLOB '*[^0-9a-f]*'
  ),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('creating', 'ready', 'removing', 'removed', 'error')),
  final_branch_tip TEXT CHECK (
    final_branch_tip IS NULL OR (
      length(final_branch_tip) IN (40, 64)
      AND final_branch_tip NOT GLOB '*[^0-9a-f]*'
    )
  ),
  safety_target_commit TEXT CHECK (
    safety_target_commit IS NULL OR (
      length(safety_target_commit) IN (40, 64)
      AND safety_target_commit NOT GLOB '*[^0-9a-f]*'
    )
  ),
  branch_deleted INTEGER NOT NULL DEFAULT 0 CHECK (branch_deleted IN (0, 1)),
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('healthy', 'missing', 'git_mismatch', 'locked', 'unknown')),
  dirty INTEGER CHECK (dirty IS NULL OR dirty IN (0, 1)),
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX worktrees_workspace_lifecycle_idx
  ON worktrees (workspace_id, lifecycle, created_at, id);
CREATE INDEX worktrees_workspace_name_idx
  ON worktrees (workspace_id, name COLLATE NOCASE, created_at, id);
CREATE INDEX worktrees_branch_ref_idx
  ON worktrees (branch_ref);

CREATE TABLE worktree_operations (
  id TEXT PRIMARY KEY NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('create', 'remove', 'delete_branch')),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  worktree_id TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
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

CREATE INDEX worktree_operations_worktree_idx
  ON worktree_operations (worktree_id, created_at, id);
CREATE INDEX worktree_operations_workspace_idx
  ON worktree_operations (workspace_id, created_at, id);
