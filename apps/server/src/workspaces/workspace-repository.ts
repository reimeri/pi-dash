import type BetterSqlite3 from "better-sqlite3";
import type { RepositoryHealth } from "@pi-dash/contracts";

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  repositoryPath: string;
  gitCommonDir: string;
  privateEnvironmentPath: string | null;
  repositoryHealth: RepositoryHealth;
  currentBranch: string | null;
  headCommit: string | null;
  checkedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type NewWorkspaceRecord = Omit<WorkspaceRecord, "sortOrder">;

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  repository_path: string;
  git_common_dir: string;
  private_environment_path: string | null;
  repository_health: RepositoryHealth;
  current_branch: string | null;
  head_commit: string | null;
  checked_at: string | null;
  sort_order: number;
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
    privateEnvironmentPath: row.private_environment_path,
    repositoryHealth: row.repository_health,
    currentBranch: row.current_branch,
    headCommit: row.head_commit,
    checkedAt: row.checked_at,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = `
  id, name, slug, repository_path, git_common_dir, private_environment_path,
  repository_health, current_branch, head_commit, checked_at, sort_order,
  created_at, updated_at
`;

export interface WorkspaceRepository {
  list(): WorkspaceRecord[];
  get(id: string): WorkspaceRecord | undefined;
  findByRepositoryPath(path: string): WorkspaceRecord | undefined;
  createFirst(input: NewWorkspaceRecord): WorkspaceRecord;
  slugExists(slug: string): boolean;
  rename(
    id: string,
    name: string,
    updatedAt: string,
  ): WorkspaceRecord | undefined;
  updatePrivateEnvironmentPath(
    id: string,
    path: string | null,
    updatedAt: string,
  ): WorkspaceRecord | undefined;
  updateHealth(
    id: string,
    health: RepositoryHealth,
    currentBranch: string | null,
    headCommit: string | null,
    checkedAt: string,
  ): WorkspaceRecord | undefined;
  reorder(ids: string[]): void;
  worktreeCount(id: string): number;
  delete(id: string): boolean;
  transaction<T>(operation: () => T): T;
}

export function createWorkspaceRepository(
  sqlite: BetterSqlite3.Database,
): WorkspaceRepository {
  const listStatement = sqlite.prepare(
    `SELECT ${SELECT_COLUMNS} FROM workspaces ORDER BY sort_order, id`,
  );
  const getStatement = sqlite.prepare(
    `SELECT ${SELECT_COLUMNS} FROM workspaces WHERE id = ?`,
  );
  const findPathStatement = sqlite.prepare(
    `SELECT ${SELECT_COLUMNS} FROM workspaces WHERE repository_path = ?`,
  );
  const insertStatement = sqlite.prepare(`
    INSERT INTO workspaces (
      id, name, slug, repository_path, git_common_dir,
      private_environment_path, repository_health, current_branch, head_commit,
      checked_at, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  const maximumOrderStatement = sqlite.prepare(
    "SELECT coalesce(max(sort_order), -1) AS maximum FROM workspaces",
  );
  const stageAllOrdersStatement = sqlite.prepare(
    "UPDATE workspaces SET sort_order = sort_order + ?",
  );
  const shiftStagedOrdersStatement = sqlite.prepare(
    "UPDATE workspaces SET sort_order = sort_order - ? WHERE sort_order >= ?",
  );
  const stageOrdersAfterStatement = sqlite.prepare(
    "UPDATE workspaces SET sort_order = sort_order + ? WHERE sort_order > ?",
  );
  const compactStagedOrdersStatement = sqlite.prepare(
    "UPDATE workspaces SET sort_order = sort_order - ? WHERE sort_order >= ?",
  );
  const stageReorderStatement = sqlite.prepare(
    "UPDATE workspaces SET sort_order = -sort_order - 1",
  );
  const setOrderStatement = sqlite.prepare(
    "UPDATE workspaces SET sort_order = ? WHERE id = ?",
  );
  const slugStatement = sqlite.prepare(
    "SELECT 1 AS present FROM workspaces WHERE slug = ?",
  );
  const renameStatement = sqlite.prepare(
    "UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?",
  );
  const updatePrivateEnvironmentPathStatement = sqlite.prepare(`
    UPDATE workspaces
    SET private_environment_path = ?, updated_at = ?
    WHERE id = ?
  `);
  const updateHealthStatement = sqlite.prepare(`
    UPDATE workspaces
    SET repository_health = ?, current_branch = ?, head_commit = ?, checked_at = ?
    WHERE id = ?
  `);
  const deleteStatement = sqlite.prepare("DELETE FROM workspaces WHERE id = ?");
  const worktreeCountStatement = sqlite.prepare(
    "SELECT count(*) AS count FROM worktrees WHERE workspace_id = ? AND lifecycle <> 'removed'",
  );

  const maximumOrder = (): number =>
    (maximumOrderStatement.get() as { maximum: number }).maximum;

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
    createFirst(input) {
      const offset = maximumOrder() + 2;
      if (offset > 1) {
        stageAllOrdersStatement.run(offset);
        shiftStagedOrdersStatement.run(offset - 1, offset);
      }
      insertStatement.run(
        input.id,
        input.name,
        input.slug,
        input.repositoryPath,
        input.gitCommonDir,
        input.privateEnvironmentPath,
        input.repositoryHealth,
        input.currentBranch,
        input.headCommit,
        input.checkedAt,
        input.createdAt,
        input.updatedAt,
      );
      return { ...input, sortOrder: 0 };
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
    updatePrivateEnvironmentPath(id, path, updatedAt) {
      if (
        updatePrivateEnvironmentPathStatement.run(path, updatedAt, id)
          .changes === 0
      ) {
        return undefined;
      }
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
    reorder(ids) {
      stageReorderStatement.run();
      ids.forEach((id, index) => setOrderStatement.run(index, id));
    },
    worktreeCount(id) {
      const result = worktreeCountStatement.get(id) as { count: number };
      return result.count;
    },
    delete(id) {
      const record = this.get(id);
      if (!record || deleteStatement.run(id).changes === 0) return false;
      const maximum = maximumOrder();
      const offset = maximum + 2;
      stageOrdersAfterStatement.run(offset, record.sortOrder);
      compactStagedOrdersStatement.run(
        offset + 1,
        offset + record.sortOrder + 1,
      );
      return true;
    },
    transaction<T>(operation: () => T): T {
      return sqlite.transaction(operation)();
    },
  };
}
