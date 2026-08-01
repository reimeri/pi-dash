import type BetterSqlite3 from "better-sqlite3";
import type {
  StatusIntegration,
  WorkflowReason,
  WorkflowState,
  WorkflowStatusDto,
} from "@pi-dash/contracts";

interface StatusRow {
  worktree_id: string;
  state: WorkflowState;
  reason: WorkflowReason;
  revision: number;
  changed_at: string;
  acknowledged_at: string | null;
  integration: StatusIntegration;
}

interface WorkspaceStatusRow extends StatusRow {
  workspace_id: string;
}

export interface WorkspaceStatusRecord {
  workspaceId: string;
  status: WorkflowStatusDto;
}

const COLUMNS = `
  worktree_id, state, reason, revision, changed_at, acknowledged_at, integration
`;

function fromRow(row: StatusRow): WorkflowStatusDto {
  return {
    worktreeId: row.worktree_id,
    state: row.state,
    reason: row.reason,
    revision: row.revision,
    changedAt: row.changed_at,
    acknowledgedAt: row.acknowledged_at,
    integration: row.integration,
  };
}

export interface StatusRepository {
  list(): WorkflowStatusDto[];
  listWithWorkspaces(): WorkspaceStatusRecord[];
  get(worktreeId: string): WorkflowStatusDto | undefined;
  transition(
    worktreeId: string,
    state: WorkflowState,
    reason: WorkflowReason,
    changedAt: string,
  ): WorkflowStatusDto | undefined;
  setIntegration(
    worktreeId: string,
    integration: StatusIntegration,
  ): WorkflowStatusDto | undefined;
  acknowledge(
    worktreeId: string,
    revision: number,
    acknowledgedAt: string,
  ): WorkflowStatusDto | undefined;
  resetActive(changedAt: string): WorkflowStatusDto[];
}

export function createStatusRepository(
  sqlite: BetterSqlite3.Database,
): StatusRepository {
  const get = sqlite.prepare(
    `SELECT ${COLUMNS} FROM workflow_status WHERE worktree_id = ?`,
  );

  const repository: StatusRepository = {
    list() {
      return (
        sqlite
          .prepare(
            `SELECT ${COLUMNS} FROM workflow_status ORDER BY worktree_id`,
          )
          .all() as StatusRow[]
      ).map(fromRow);
    },
    listWithWorkspaces() {
      return (
        sqlite
          .prepare(
            `
            SELECT workflow_status.*, worktrees.workspace_id
            FROM workflow_status
            INNER JOIN worktrees ON worktrees.id = workflow_status.worktree_id
            WHERE worktrees.lifecycle <> 'removed'
            ORDER BY worktrees.workspace_id, workflow_status.worktree_id
          `,
          )
          .all() as WorkspaceStatusRow[]
      ).map((row) => ({ workspaceId: row.workspace_id, status: fromRow(row) }));
    },
    get(worktreeId) {
      const row = get.get(worktreeId) as StatusRow | undefined;
      return row ? fromRow(row) : undefined;
    },
    transition(worktreeId, state, reason, changedAt) {
      const current = repository.get(worktreeId);
      if (!current) return undefined;
      if (current.state === state && current.reason === reason) return current;
      sqlite
        .prepare(
          `
          UPDATE workflow_status
          SET state = ?, reason = ?, revision = revision + 1, changed_at = ?,
              acknowledged_at = NULL
          WHERE worktree_id = ?
        `,
        )
        .run(state, reason, changedAt, worktreeId);
      return repository.get(worktreeId);
    },
    setIntegration(worktreeId, integration) {
      sqlite
        .prepare(
          "UPDATE workflow_status SET integration = ? WHERE worktree_id = ? AND integration <> ?",
        )
        .run(integration, worktreeId, integration);
      return repository.get(worktreeId);
    },
    acknowledge(worktreeId, revision, acknowledgedAt) {
      const result = sqlite
        .prepare(
          `
          UPDATE workflow_status
          SET state = 'idle', reason = 'acknowledged', revision = revision + 1,
              changed_at = ?, acknowledged_at = ?
          WHERE worktree_id = ? AND state = 'done' AND revision = ?
        `,
        )
        .run(acknowledgedAt, acknowledgedAt, worktreeId, revision);
      return result.changes > 0 ? repository.get(worktreeId) : undefined;
    },
    resetActive(changedAt) {
      const affected = sqlite
        .prepare(
          "SELECT worktree_id FROM workflow_status WHERE state IN ('working', 'blocked')",
        )
        .all() as Array<{ worktree_id: string }>;
      sqlite
        .prepare(
          `
          UPDATE workflow_status
          SET state = 'idle', reason = 'runtime_reset', revision = revision + 1,
              changed_at = ?, acknowledged_at = NULL,
              integration = 'disconnected'
          WHERE state IN ('working', 'blocked')
        `,
        )
        .run(changedAt);
      sqlite
        .prepare(
          "UPDATE workflow_status SET integration = 'disconnected' WHERE integration = 'connected'",
        )
        .run();
      return affected
        .map(({ worktree_id }) => repository.get(worktree_id))
        .filter((status): status is WorkflowStatusDto => status !== undefined);
    },
  };
  return repository;
}
