CREATE TABLE workflow_status (
  worktree_id TEXT PRIMARY KEY NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'working', 'blocked', 'done')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('agent', 'ask_user', 'settled', 'acknowledged', 'runtime_reset')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changed_at TEXT NOT NULL,
  acknowledged_at TEXT,
  integration TEXT NOT NULL DEFAULT 'disconnected' CHECK (integration IN ('connected', 'disconnected', 'unsupported'))
);

INSERT INTO workflow_status (worktree_id, state, reason, revision, changed_at, integration)
SELECT id, 'idle', NULL, 0, created_at, 'disconnected'
FROM worktrees;

CREATE TRIGGER workflow_status_after_worktree_insert
AFTER INSERT ON worktrees
BEGIN
  INSERT INTO workflow_status (
    worktree_id, state, reason, revision, changed_at, integration
  ) VALUES (NEW.id, 'idle', NULL, 0, NEW.created_at, 'disconnected');
END;

CREATE INDEX workflow_status_state_idx
  ON workflow_status (state, changed_at, worktree_id);
