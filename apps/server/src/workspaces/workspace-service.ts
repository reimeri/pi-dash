import { randomUUID } from "node:crypto";
import type {
  ApiErrorCode,
  RepositoryHealth,
  WorkspaceDto,
  WorkspacePreviewResponse,
} from "@pi-dash/contracts";
import {
  defaultWorkspaceName,
  GitInspectionError,
  type GitInspector,
} from "../git/git-inspector.js";
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
  remove(id: string): void;
  refresh(id: string, signal?: AbortSignal): Promise<WorkspaceDto>;
  refreshAll(): Promise<void>;
  startHealthRefresh(): void;
  close(): void;
}

export function createWorkspaceService(options: {
  repository: WorkspaceRepository;
  git: GitInspector;
  now?: () => Date;
  id?: () => string;
  refreshIntervalMs?: number;
}): WorkspaceService {
  const now = options.now ?? (() => new Date());
  const createId = options.id ?? randomUUID;
  const refreshIntervalMs = options.refreshIntervalMs ?? 5 * 60_000;
  const refreshController = new AbortController();
  const refreshQueues = new Map<string, Promise<void>>();
  let interval: NodeJS.Timeout | undefined;
  let refreshActive = false;

  const toDto = (record: WorkspaceRecord): WorkspaceDto => ({
    id: record.id,
    name: record.name,
    slug: record.slug,
    repositoryPath: record.repositoryPath,
    repository: {
      health: record.repositoryHealth,
      currentBranch: record.currentBranch,
      headCommit: record.headCommit,
      checkedAt: record.checkedAt,
    },
    worktreeCount: options.repository.worktreeCount(record.id),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

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
      return options.repository.transaction(() => {
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
          options.repository.create({
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
    remove(id) {
      requireRecord(id);
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
    },
    refresh(id, signal) {
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
          const updated = options.repository.updateHealth(
            id,
            health.health,
            health.currentBranch,
            health.headCommit,
            health.checkedAt,
          );
          if (!updated) return service.get(id);
          return toDto(updated);
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
        const records = options.repository.list();
        for (const record of records) {
          if (refreshController.signal.aborted) break;
          try {
            await service.refresh(record.id, refreshController.signal);
          } catch {
            // A background probe must not make cached workspace data unavailable.
          }
        }
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
