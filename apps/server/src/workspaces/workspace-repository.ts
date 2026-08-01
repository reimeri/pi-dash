import type BetterSqlite3 from "better-sqlite3";
import type { RepositoryHealth } from "@pi-dash/contracts";

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  repositoryPath: string;
  gitCommonDir: string;
  repositoryHealth: RepositoryHealth;
  currentBranch: string | null;
  headCommit: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  repository_path: string;
  git_common_dir: string;
  repository_health: RepositoryHealth;
  current_branch: string | null;
  head_commit: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    repositoryPath: row.repository_path,
    gitCommonDir: row.git_common_dir,
    repositoryHealth: row.repository_health,
    currentBranch: row.current_branch,
    headCommit: row.head_commit,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `
  id, name, slug, repository_path, git_common_dir, repository_health,
  current_branch, head_commit, checked_at, created_at, updated_at
`;

export interface WorkspaceRepository {
  list(): WorkspaceRecord[];
  get(id: string): WorkspaceRecord | undefined;
  findByRepositoryPath(path: string): WorkspaceRecord | undefined;
  create(input: WorkspaceRecord): WorkspaceRecord;
  slugExists(slug: string): boolean;
  rename(
    id: string,
    name: string,
    updatedAt: string,
  ): WorkspaceRecord | undefined;
  updateHealth(
    id: string,
    health: RepositoryHealth,
    currentBranch: string | null,
    headCommit: string | null,
    checkedAt: string,
  ): WorkspaceRecord | undefined;
  worktreeCount(id: string): number;
  delete(id: string): boolean;
  transaction<T>(operation: () => T): T;
}

export function createWorkspaceRepository(
  sqlite: BetterSqlite3.Database,
): WorkspaceRepository {
  const listStatement = sqlite.prepare(
    `SELECT ${SELECT_COLUMNS} FROM workspaces ORDER BY name COLLATE NOCASE, created_at, id`,
  );
  const getStatement = sqlite.prepare(
    `SELECT ${SELECT_COLUMNS} FROM workspaces WHERE id = ?`,
  );
  const findPathStatement = sqlite.prepare(
    `SELECT ${SELECT_COLUMNS} FROM workspaces WHERE repository_path = ?`,
  );
  const insertStatement = sqlite.prepare(`
    INSERT INTO workspaces (
      id, name, slug, repository_path, git_common_dir, repository_health,
      current_branch, head_commit, checked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const slugStatement = sqlite.prepare(
    "SELECT 1 AS present FROM workspaces WHERE slug = ?",
  );
  const renameStatement = sqlite.prepare(
    "UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?",
  );
  const updateHealthStatement = sqlite.prepare(`
    UPDATE workspaces
    SET repository_health = ?, current_branch = ?, head_commit = ?, checked_at = ?
    WHERE id = ?
  `);
  const deleteStatement = sqlite.prepare("DELETE FROM workspaces WHERE id = ?");
  const worktreeCountStatement = sqlite.prepare(
    "SELECT count(*) AS count FROM worktrees WHERE workspace_id = ? AND lifecycle <> 'removed'",
  );

  return {
    list() {
      return (listStatement.all() as WorkspaceRow[]).map(fromRow);
    },
    get(id) {
      const row = getStatement.get(id) as WorkspaceRow | undefined;
      return row ? fromRow(row) : undefined;
    },
    findByRepositoryPath(path) {
      const row = findPathStatement.get(path) as WorkspaceRow | undefined;
      return row ? fromRow(row) : undefined;
    },
    create(input) {
      insertStatement.run(
        input.id,
        input.name,
        input.slug,
        input.repositoryPath,
        input.gitCommonDir,
        input.repositoryHealth,
        input.currentBranch,
        input.headCommit,
        input.checkedAt,
        input.createdAt,
        input.updatedAt,
      );
      return input;
    },
    slugExists(slug) {
      return Boolean(slugStatement.get(slug));
    },
    rename(id, name, updatedAt) {
      if (renameStatement.run(name, updatedAt, id).changes === 0)
        return undefined;
      const row = getStatement.get(id) as WorkspaceRow;
      return fromRow(row);
    },
    updateHealth(id, health, currentBranch, headCommit, checkedAt) {
      if (
        updateHealthStatement.run(
          health,
          currentBranch,
          headCommit,
          checkedAt,
          id,
        ).changes === 0
      ) {
        return undefined;
      }
      const row = getStatement.get(id) as WorkspaceRow;
      return fromRow(row);
    },
    worktreeCount(id) {
      const result = worktreeCountStatement.get(id) as { count: number };
      return result.count;
    },
    delete(id) {
      return deleteStatement.run(id).changes > 0;
    },
    transaction<T>(operation: () => T): T {
      return sqlite.transaction(operation)();
    },
  };
}
