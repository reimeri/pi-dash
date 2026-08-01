CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  slug TEXT NOT NULL UNIQUE CHECK (
    length(slug) BETWEEN 1 AND 80
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '-%'
    AND slug NOT LIKE '%-'
    AND slug NOT LIKE '%--%'
  ),
  repository_path TEXT NOT NULL UNIQUE,
  git_common_dir TEXT NOT NULL,
  repository_health TEXT NOT NULL DEFAULT 'healthy' CHECK (
    repository_health IN ('healthy', 'missing', 'inaccessible', 'not_git', 'changed')
  ),
  current_branch TEXT,
  head_commit TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX workspaces_name_order_idx
  ON workspaces (name COLLATE NOCASE, created_at, id);
CREATE INDEX workspaces_git_common_dir_idx
  ON workspaces (git_common_dir);
