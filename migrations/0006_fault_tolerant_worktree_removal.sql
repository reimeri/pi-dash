CREATE TABLE worktree_removal_journal (
  operation_id TEXT PRIMARY KEY NOT NULL
    REFERENCES worktree_operations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  worktree_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('safe', 'force')),
  prior_lifecycle TEXT NOT NULL CHECK (prior_lifecycle IN ('ready', 'error')),
  strategy TEXT NOT NULL CHECK (strategy IN ('git', 'filesystem_only')),
  phase TEXT NOT NULL CHECK (
    phase IN ('prepared', 'mutation_started', 'quarantined', 'purged', 'finalized')
  ),
  original_path TEXT NOT NULL,
  quarantine_path TEXT,
  original_device TEXT,
  original_inode TEXT,
  original_kind TEXT CHECK (
    original_kind IS NULL OR original_kind IN ('directory', 'symlink', 'other')
  ),
  recorded_branch_ref TEXT NOT NULL,
  cleanup_branch_ref TEXT,
  cleanup_branch_tip TEXT CHECK (
    cleanup_branch_tip IS NULL OR (
      length(cleanup_branch_tip) IN (40, 64)
      AND cleanup_branch_tip NOT GLOB '*[^0-9a-f]*'
    )
  ),
  inspection_json TEXT NOT NULL CHECK (json_valid(inspection_json)),
  warnings_json TEXT NOT NULL CHECK (json_valid(warnings_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX worktree_removal_journal_workspace_idx
  ON worktree_removal_journal (workspace_id, phase, created_at, operation_id);
CREATE INDEX worktree_removal_journal_worktree_idx
  ON worktree_removal_journal (worktree_id, phase, created_at, operation_id);
