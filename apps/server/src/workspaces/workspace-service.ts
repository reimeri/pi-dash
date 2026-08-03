import { randomUUID } from "node:crypto";
import type {
  ApiErrorCode,
  RepositoryHealth,
  WorkspaceDto,
  WorkspacePreviewResponse,
  WorkspaceSyncStatus,
} from "@pi-dash/contracts";
import {
  defaultWorkspaceName,
  GitInspectionError,
  type GitInspector,
} from "../git/git-inspector.js";
import {
  GitWorkspaceSyncError,
  type GitWorkspaceSynchronizer,
} from "../git/git-workspace-sync.js";
import { ProcessExecutionError } from "../process/safe-process.js";
import {
  GitMutationBusyError,
  type GitMutationLock,
} from "../worktrees/git-mutation-lock.js";
import type {
  WorkspaceRecord,
  WorkspaceRepository,
} from "./workspace-repository.js";

export class WorkspaceServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkspaceServiceError";
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => /[\p{Cc}\p{Cf}]/u.test(character));
}

function normalizeName(input: string): string {
  const name = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!name || name.length > 100 || hasControlCharacters(name)) {
    throw new WorkspaceServiceError(
      400,
      "VALIDATION_ERROR",
      "Workspace name must be 1 to 100 characters without control characters",
    );
  }
  return name;
}

export function workspaceSlugBase(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || "workspace";
}

function inspectionError(error: GitInspectionError): WorkspaceServiceError {
  const statuses: Record<GitInspectionError["code"], number> = {
    PATH_NOT_FOUND: 404,
    PATH_INACCESSIBLE: 422,
    VALIDATION_ERROR: 400,
    NOT_A_GIT_WORKTREE: 422,
    GIT_UNAVAILABLE: 503,
    GIT_TIMEOUT: 504,
  };
  return new WorkspaceServiceError(
    statuses[error.code],
    error.code,
    error.message,
  );
}

export interface WorkspaceService {
  list(): WorkspaceDto[];
  get(id: string): WorkspaceDto;
  preview(
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspacePreviewResponse>;
  create(input: {
    path: string;
    name: string;
    signal?: AbortSignal;
  }): Promise<WorkspaceDto>;
  rename(id: string, name: string): WorkspaceDto;
  reorder(expectedIds: string[], ids: string[]): WorkspaceDto[];
  remove(id: string): void;
  refresh(id: string, signal?: AbortSignal): Promise<WorkspaceDto>;
  sync(id: string, signal?: AbortSignal): Promise<WorkspaceDto>;
  refreshAll(): Promise<void>;
  startHealthRefresh(): void;
  close(): void;
}

export function createWorkspaceService(options: {
  repository: WorkspaceRepository;
  git: GitInspector;
  syncer: GitWorkspaceSynchronizer;
  lock: GitMutationLock;
  onRepositoryChange?: (workspace: WorkspaceDto) => void;
  onOrderChange?: (workspaceIds: string[]) => void;
  now?: () => Date;
  id?: () => string;
  refreshIntervalMs?: number;
}): WorkspaceService {
  const now = options.now ?? (() => new Date());
  const createId = options.id ?? randomUUID;
  const refreshIntervalMs = options.refreshIntervalMs ?? 5 * 60_000;
  const refreshController = new AbortController();
  const refreshQueues = new Map<string, Promise<void>>();
  const pendingGitOperations = new Map<string, number>();
  const syncStatuses = new Map<string, WorkspaceSyncStatus>();
  let interval: NodeJS.Timeout | undefined;
  let refreshActive = false;

  const toDto = (record: WorkspaceRecord): WorkspaceDto => ({
    id: record.id,
    name: record.name,
    slug: record.slug,
    repositoryPath: record.repositoryPath,
    repository: {
      health: record.repositoryHealth,
      syncStatus:
        record.repositoryHealth === "healthy"
          ? (syncStatuses.get(record.id) ?? "unknown")
          : "unknown",
      currentBranch: record.currentBranch,
      headCommit: record.headCommit,
      checkedAt: record.checkedAt,
    },
    worktreeCount: options.repository.worktreeCount(record.id),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

  const publishRepositoryChange = (workspace: WorkspaceDto): void => {
    try {
      options.onRepositoryChange?.(workspace);
    } catch {
      // Persisted repository state must not be undone by event publication.
    }
  };

  const publishOrderChange = (): void => {
    try {
      options.onOrderChange?.(
        options.repository.list().map((workspace) => workspace.id),
      );
    } catch {
      // Persisted workspace order must not be undone by event publication.
    }
  };

  const requireRecord = (id: string): WorkspaceRecord => {
    const record = options.repository.get(id);
    if (!record) {
      throw new WorkspaceServiceError(
        404,
        "NOT_FOUND",
        "Workspace was not found",
      );
    }
    return record;
  };

  const inspect = async (path: string, signal?: AbortSignal) => {
    try {
      return await options.git.inspect(path, signal);
    } catch (error) {
      if (error instanceof GitInspectionError) throw inspectionError(error);
      throw error;
    }
  };

  const inspectSyncStatus = async (
    record: WorkspaceRecord,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncStatus> => {
    try {
      return await options.lock.runExclusive(record.gitCommonDir, () =>
        options.syncer.status(record.repositoryPath, signal),
      );
    } catch (error) {
      if (
        error instanceof GitWorkspaceSyncError ||
        error instanceof GitMutationBusyError
      ) {
        return "unknown";
      }
      throw error;
    }
  };

  const syncStatusAfterError = (error: unknown): WorkspaceSyncStatus => {
    if (!(error instanceof GitWorkspaceSyncError)) return "unknown";
    if (error.code === "WORKSPACE_SYNC_DIRTY") return "dirty";
    if (error.code === "WORKSPACE_SYNC_AHEAD") return "ahead";
    if (error.code === "WORKSPACE_SYNC_DIVERGED") return "diverged";
    return "unknown";
  };

  const service: WorkspaceService = {
    list() {
      return options.repository.list().map(toDto);
    },
    get(id) {
      return toDto(requireRecord(id));
    },
    async preview(path, signal) {
      const result = await inspect(path, signal);
      return {
        repositoryPath: result.repositoryPath,
        defaultName: defaultWorkspaceName(result.repositoryPath),
      };
    },
    async create(input) {
      const inspection = await inspect(input.path, input.signal);
      const name = normalizeName(input.name);
      const workspace = options.repository.transaction(() => {
        const existing = options.repository.findByRepositoryPath(
          inspection.repositoryPath,
        );
        if (existing) {
          throw new WorkspaceServiceError(
            409,
            "WORKSPACE_EXISTS",
            "This repository is already registered",
            { workspaceId: existing.id, workspaceName: existing.name },
          );
        }

        if (options.repository.list().length >= 50) {
          throw new WorkspaceServiceError(
            409,
            "LIMIT_EXCEEDED",
            "Pi Dash supports up to 50 registered workspaces",
          );
        }

        const base = workspaceSlugBase(name);
        let slug = base;
        let suffix = 2;
        while (options.repository.slugExists(slug)) {
          const ending = `-${suffix}`;
          slug = `${base.slice(0, 80 - ending.length).replace(/-+$/g, "")}${ending}`;
          suffix += 1;
        }
        const timestamp = now().toISOString();
        return toDto(
          options.repository.createFirst({
            id: createId(),
            name,
            slug,
            repositoryPath: inspection.repositoryPath,
            gitCommonDir: inspection.gitCommonDir,
            repositoryHealth: "healthy",
            currentBranch: inspection.currentBranch,
            headCommit: inspection.headCommit,
            checkedAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
      });
      publishOrderChange();
      return workspace;
    },
    rename(id, inputName) {
      requireRecord(id);
      const record = options.repository.rename(
        id,
        normalizeName(inputName),
        now().toISOString(),
      );
      return toDto(record!);
    },
    reorder(expectedIds, ids) {
      const hasDuplicates = (values: string[]): boolean =>
        new Set(values).size !== values.length;
      if (hasDuplicates(expectedIds) || hasDuplicates(ids)) {
        throw new WorkspaceServiceError(
          400,
          "VALIDATION_ERROR",
          "Workspace order cannot contain duplicate IDs",
        );
      }
      const workspaces = options.repository.transaction(() => {
        const currentIds = options.repository
          .list()
          .map((workspace) => workspace.id);
        if (
          currentIds.length !== expectedIds.length ||
          currentIds.some((id, index) => expectedIds[index] !== id)
        ) {
          throw new WorkspaceServiceError(
            409,
            "WORKSPACE_ORDER_CHANGED",
            "Workspace order changed before this reorder was applied",
            { workspaceIds: currentIds },
          );
        }
        const currentIdSet = new Set(currentIds);
        if (
          ids.length !== currentIds.length ||
          ids.some((id) => !currentIdSet.has(id))
        ) {
          throw new WorkspaceServiceError(
            400,
            "VALIDATION_ERROR",
            "Workspace order must contain every workspace exactly once",
          );
        }
        options.repository.reorder(ids);
        return options.repository.list().map(toDto);
      });
      publishOrderChange();
      return workspaces;
    },
    remove(id) {
      requireRecord(id);
      if ((pendingGitOperations.get(id) ?? 0) > 0) {
        throw new WorkspaceServiceError(
          409,
          "GIT_OPERATION_BUSY",
          "A repository operation is already in progress for this workspace",
        );
      }
      options.repository.transaction(() => {
        const count = options.repository.worktreeCount(id);
        if (count > 0) {
          throw new WorkspaceServiceError(
            409,
            "WORKSPACE_HAS_WORKTREES",
            "Remove managed worktrees before removing this workspace",
            { worktreeCount: count },
          );
        }
        options.repository.delete(id);
      });
      syncStatuses.delete(id);
      publishOrderChange();
    },
    refresh(id, signal) {
      pendingGitOperations.set(id, (pendingGitOperations.get(id) ?? 0) + 1);
      const previous = refreshQueues.get(id) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          const record = requireRecord(id);
          let health: {
            health: RepositoryHealth;
            currentBranch: string | null;
            headCommit: string | null;
            checkedAt: string;
          };
          try {
            health = await options.git.inspectHealth(
              record.repositoryPath,
              record.gitCommonDir,
              signal,
            );
          } catch (error) {
            if (error instanceof GitInspectionError)
              throw inspectionError(error);
            throw error;
          }
          const syncStatus =
            health.health === "healthy"
              ? await inspectSyncStatus(record, signal)
              : "unknown";
          syncStatuses.set(id, syncStatus);
          const updated = options.repository.updateHealth(
            id,
            health.health,
            health.currentBranch,
            health.headCommit,
            health.checkedAt,
          );
          const workspace = updated ? toDto(updated) : service.get(id);
          publishRepositoryChange(workspace);
          return workspace;
        })
        .catch((error) => {
          syncStatuses.set(id, "unknown");
          const current = options.repository.get(id);
          if (current) publishRepositoryChange(toDto(current));
          throw error;
        })
        .finally(() => {
          const remaining = (pendingGitOperations.get(id) ?? 1) - 1;
          if (remaining === 0) pendingGitOperations.delete(id);
          else pendingGitOperations.set(id, remaining);
        });
      const queueTail = operation.then(
        () => undefined,
        () => undefined,
      );
      refreshQueues.set(id, queueTail);
      void queueTail.finally(() => {
        if (refreshQueues.get(id) === queueTail) refreshQueues.delete(id);
      });
      return operation;
    },
    sync(id, signal) {
      pendingGitOperations.set(id, (pendingGitOperations.get(id) ?? 0) + 1);
      const previous = refreshQueues.get(id) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          const record = requireRecord(id);
          try {
            return await options.lock.runExclusive(
              record.gitCommonDir,
              async () => {
                const before = await options.git.inspectHealth(
                  record.repositoryPath,
                  record.gitCommonDir,
                  signal,
                );
                if (before.health !== "healthy") {
                  syncStatuses.set(id, "unknown");
                  const degraded = options.repository.updateHealth(
                    id,
                    before.health,
                    before.currentBranch,
                    before.headCommit,
                    before.checkedAt,
                  );
                  if (degraded) publishRepositoryChange(toDto(degraded));
                  throw new WorkspaceServiceError(
                    409,
                    "WORKSPACE_UNHEALTHY",
                    "Repository health must be restored before syncing",
                  );
                }

                let result: { headCommit: string };
                try {
                  result = await options.syncer.sync(
                    record.repositoryPath,
                    signal,
                  );
                } catch (error) {
                  syncStatuses.set(id, syncStatusAfterError(error));
                  try {
                    const finalInspection = await options.git.inspectHealth(
                      record.repositoryPath,
                      record.gitCommonDir,
                    );
                    const finalized = options.repository.updateHealth(
                      id,
                      finalInspection.health,
                      finalInspection.currentBranch,
                      finalInspection.headCommit,
                      finalInspection.checkedAt,
                    );
                    if (finalized) publishRepositoryChange(toDto(finalized));
                  } catch {
                    // Preserve the original sync failure when final inspection fails.
                  }
                  throw error;
                }
                const after = await options.git.inspectHealth(
                  record.repositoryPath,
                  record.gitCommonDir,
                );
                syncStatuses.set(
                  id,
                  after.health === "healthy" &&
                    after.headCommit === result.headCommit
                    ? "synchronized"
                    : "unknown",
                );
                const updated = options.repository.updateHealth(
                  id,
                  after.health,
                  after.currentBranch,
                  after.headCommit,
                  after.checkedAt,
                );
                const workspace = updated ? toDto(updated) : service.get(id);
                publishRepositoryChange(workspace);
                if (
                  after.health !== "healthy" ||
                  after.headCommit !== result.headCommit
                ) {
                  throw new WorkspaceServiceError(
                    409,
                    "WORKSPACE_UNHEALTHY",
                    "The repository changed unexpectedly while syncing",
                  );
                }
                return workspace;
              },
            );
          } catch (error) {
            if (error instanceof WorkspaceServiceError) throw error;
            if (error instanceof GitMutationBusyError) {
              throw new WorkspaceServiceError(
                409,
                "GIT_OPERATION_BUSY",
                error.message,
              );
            }
            if (error instanceof GitWorkspaceSyncError) {
              const status =
                error.code === "GIT_UNAVAILABLE"
                  ? 503
                  : error.code === "GIT_TIMEOUT"
                    ? 504
                    : error.code === "WORKSPACE_SYNC_FAILED"
                      ? 502
                      : 409;
              throw new WorkspaceServiceError(
                status,
                error.code,
                error.message,
              );
            }
            if (
              error instanceof ProcessExecutionError &&
              error.reason === "aborted"
            ) {
              throw new WorkspaceServiceError(
                503,
                "WORKSPACE_SYNC_FAILED",
                "Workspace sync was cancelled",
              );
            }
            if (error instanceof GitInspectionError) {
              throw inspectionError(error);
            }
            throw error;
          }
        })
        .finally(() => {
          const remaining = (pendingGitOperations.get(id) ?? 1) - 1;
          if (remaining === 0) pendingGitOperations.delete(id);
          else pendingGitOperations.set(id, remaining);
        });
      const queueTail = operation.then(
        () => undefined,
        () => undefined,
      );
      refreshQueues.set(id, queueTail);
      void queueTail.finally(() => {
        if (refreshQueues.get(id) === queueTail) refreshQueues.delete(id);
      });
      return operation;
    },
    async refreshAll() {
      if (refreshActive || refreshController.signal.aborted) return;
      refreshActive = true;
      try {
        const groups = new Map<string, WorkspaceRecord[]>();
        for (const record of options.repository.list()) {
          const group = groups.get(record.gitCommonDir) ?? [];
          group.push(record);
          groups.set(record.gitCommonDir, group);
        }
        const queue = [...groups.values()];
        let nextGroup = 0;
        const worker = async () => {
          while (!refreshController.signal.aborted) {
            const group = queue[nextGroup];
            nextGroup += 1;
            if (!group) return;
            for (const record of group) {
              if (refreshController.signal.aborted) return;
              try {
                await service.refresh(record.id, refreshController.signal);
              } catch {
                // A background probe must not make cached workspace data unavailable.
              }
            }
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(3, queue.length) }, () => worker()),
        );
      } finally {
        refreshActive = false;
      }
    },
    startHealthRefresh() {
      if (interval) return;
      void service.refreshAll();
      interval = setInterval(
        () => void service.refreshAll(),
        refreshIntervalMs,
      );
      interval.unref();
    },
    close() {
      refreshController.abort();
      if (interval) clearInterval(interval);
      interval = undefined;
    },
  };
  return service;
}
