import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  ApiErrorCode,
  CreateWorktreeRequest,
  DeleteWorktreeBranchRequest,
  DeleteWorktreeBranchResponse,
  RemoveWorktreeResponse,
  WorkspaceRefsResponse,
  WorktreeDto,
  WorktreeResponse,
} from "@pi-dash/contracts";
import {
  GitWorktreeError,
  type GitWorktreeListEntry,
  type GitWorktreeManager,
} from "../git/git-worktree-manager.js";
import { ProcessExecutionError } from "../process/safe-process.js";
import type { WorkspaceRepository } from "../workspaces/workspace-repository.js";
import type { BaseSnapshotSigner } from "./base-snapshot.js";
import {
  GitMutationBusyError,
  type GitMutationLock,
} from "./git-mutation-lock.js";
import type { WorktreeLifecycleCoordinator } from "./worktree-lifecycle.js";
import type {
  WorktreeOperationRecord,
  WorktreeOperationType,
  WorktreeRecord,
  WorktreeRepository,
} from "./worktree-repository.js";
import {
  allocateWorktreePath,
  assertAllocatedPathAvailable,
  assertCanonicalManagedPath,
  deriveBranchRef,
  normalizeWorktreeName,
  validateWorktreeSlug,
  WorktreeValidationError,
} from "./worktree-validation.js";

export class WorktreeServiceError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorktreeServiceError";
  }
}

interface OperationStart<T> {
  operation: WorktreeOperationRecord;
  prior?: T;
}

function requestHash(operation: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ operation, input }))
    .digest("hex");
}

function serviceError(
  error: unknown,
  fallbackCode: ApiErrorCode,
): WorktreeServiceError {
  if (error instanceof WorktreeServiceError) return error;
  if (error instanceof GitMutationBusyError) {
    return new WorktreeServiceError(409, "GIT_OPERATION_BUSY", error.message);
  }
  if (error instanceof WorktreeValidationError) {
    return new WorktreeServiceError(
      error.code === "PATH_EXISTS" ? 409 : 400,
      error.code,
      error.message,
    );
  }
  if (error instanceof GitWorktreeError) {
    const status: Partial<Record<GitWorktreeError["code"], number>> = {
      GIT_UNAVAILABLE: 503,
      GIT_TIMEOUT: 504,
      BASE_REF_INVALID: 400,
      BRANCH_INVALID: 400,
      BRANCH_EXISTS: 409,
      PATH_EXISTS: 409,
      WORKTREE_MISSING: 409,
      BRANCH_CHANGED: 409,
    };
    return new WorktreeServiceError(
      status[error.code] ?? 500,
      error.code,
      error.message,
    );
  }
  if (error instanceof ProcessExecutionError && error.reason === "aborted") {
    return new WorktreeServiceError(
      503,
      fallbackCode,
      "Operation was cancelled",
    );
  }
  return new WorktreeServiceError(
    500,
    fallbackCode,
    "Git operation could not be completed safely",
  );
}

function toDto(record: WorktreeRecord): WorktreeDto {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    slug: record.slug,
    path: record.path,
    branchRef: record.branchRef,
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    lifecycle: record.lifecycle,
    finalBranchTip: record.finalBranchTip,
    safetyTargetCommit: record.safetyTargetCommit,
    branchDeleted: record.branchDeleted,
    health: record.health,
    dirty: record.dirty,
    ...(record.lastErrorCode && record.lastErrorMessage
      ? {
          lastError: {
            code: record.lastErrorCode,
            message: record.lastErrorMessage,
          },
        }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function exactEntry(
  entries: GitWorktreeListEntry[],
  record: WorktreeRecord,
): GitWorktreeListEntry | undefined {
  return entries.find((entry) => entry.path === record.path);
}

export interface WorktreeService {
  refs(
    workspaceId: string,
    query?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<WorkspaceRefsResponse>;
  list(workspaceId: string): WorktreeDto[];
  get(id: string): WorktreeDto;
  create(
    workspaceId: string,
    input: CreateWorktreeRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorktreeResponse>;
  remove(
    id: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<RemoveWorktreeResponse>;
  deleteBranch(
    id: string,
    input: DeleteWorktreeBranchRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<DeleteWorktreeBranchResponse>;
  reconcile(workspaceId?: string): Promise<void>;
}

export function createWorktreeService(options: {
  repository: WorktreeRepository;
  workspaces: WorkspaceRepository;
  git: GitWorktreeManager;
  lock: GitMutationLock;
  lifecycle: WorktreeLifecycleCoordinator;
  snapshots: BaseSnapshotSigner;
  managedRoot: string;
  stopRuntime?: (worktree: WorktreeDto) => Promise<void>;
  now?: () => Date;
  id?: () => string;
}): WorktreeService {
  const now = options.now ?? (() => new Date());
  const createId = options.id ?? randomUUID;
  const stopRuntime = options.stopRuntime ?? (async () => undefined);
  const activeOperations = new Set<string>();

  const requireWorkspace = (id: string) => {
    const workspace = options.workspaces.get(id);
    if (!workspace) {
      throw new WorktreeServiceError(
        404,
        "NOT_FOUND",
        "Workspace was not found",
      );
    }
    return workspace;
  };
  const requireRecord = (id: string) => {
    const record = options.repository.get(id);
    if (!record) {
      throw new WorktreeServiceError(
        404,
        "WORKTREE_NOT_MANAGED",
        "Managed worktree was not found",
      );
    }
    return record;
  };

  const hasExactManagedPath = (record: WorktreeRecord): boolean => {
    try {
      const metadata = lstatSync(record.path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false;
      const managedRoot = realpathSync(options.managedRoot);
      const workspaceRoot = realpathSync(
        resolve(managedRoot, record.workspaceId),
      );
      const canonicalPath = realpathSync(record.path);
      const managedRelative = relative(managedRoot, canonicalPath);
      const workspaceRelative = relative(workspaceRoot, canonicalPath);
      return (
        canonicalPath === record.path &&
        managedRelative !== "" &&
        !managedRelative.startsWith("..") &&
        !isAbsolute(managedRelative) &&
        workspaceRelative !== "" &&
        !workspaceRelative.startsWith("..") &&
        !isAbsolute(workspaceRelative)
      );
    } catch {
      return false;
    }
  };

  const inspectExactManagedWorktree = async (
    record: WorktreeRecord,
    workspace: { repositoryPath: string; gitCommonDir: string },
    signal?: AbortSignal,
  ): Promise<GitWorktreeListEntry | undefined> => {
    if (!hasExactManagedPath(record)) return undefined;
    const entries = await options.git.list(workspace.repositoryPath, signal);
    const entry = exactEntry(entries, record);
    if (
      !entry ||
      entry.branchRef !== record.branchRef ||
      !entry.head ||
      (await options.git.commonDir(record.path, signal)) !==
        workspace.gitCommonDir
    ) {
      return undefined;
    }
    return entry;
  };

  const beginOperation = <T>(input: {
    type: WorktreeOperationType;
    workspaceId: string;
    worktreeId: string | null;
    idempotencyKey: string;
    hash: string;
    requestJson: string;
  }): OperationStart<T> => {
    const timestamp = now().toISOString();
    return options.repository.transaction(() => {
      const existing = options.repository.findOperation(input.idempotencyKey);
      if (existing) {
        if (existing.requestHash !== input.hash) {
          throw new WorktreeServiceError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key was already used with different input",
          );
        }
        if (existing.status === "in_progress") {
          throw new WorktreeServiceError(
            409,
            "OPERATION_IN_PROGRESS",
            "The prior operation is still in progress",
            { operationId: existing.id, worktreeId: existing.worktreeId },
          );
        }
        if (existing.status === "failed") {
          throw new WorktreeServiceError(
            existing.httpStatus ?? 409,
            existing.errorCode ?? "CONFLICT",
            existing.errorMessage ?? "The prior operation failed",
            { operationId: existing.id, worktreeId: existing.worktreeId },
          );
        }
        return {
          operation: existing,
          prior: JSON.parse(existing.resultJson!) as T,
        };
      }
      const operation: WorktreeOperationRecord = {
        id: createId(),
        idempotencyKey: input.idempotencyKey,
        operationType: input.type,
        workspaceId: input.workspaceId,
        worktreeId: input.worktreeId,
        requestHash: input.hash,
        requestJson: input.requestJson,
        status: "in_progress",
        httpStatus: null,
        resultJson: null,
        errorCode: null,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      options.repository.createOperation(operation);
      activeOperations.add(operation.id);
      return { operation };
    });
  };

  const complete = <T>(operationId: string, status: number, result: T): T => {
    activeOperations.delete(operationId);
    options.repository.completeOperation(
      operationId,
      status,
      JSON.stringify(result),
      now().toISOString(),
    );
    return result;
  };
  const fail = (operationId: string, error: WorktreeServiceError): never => {
    activeOperations.delete(operationId);
    options.repository.failOperation(
      operationId,
      error.statusCode,
      error.code,
      error.message,
      now().toISOString(),
    );
    throw error;
  };

  const setError = (
    id: string,
    code: ApiErrorCode,
    message: string,
    health: WorktreeRecord["health"] = "unknown",
  ) =>
    options.repository.updateState(id, {
      lifecycle: "error",
      health,
      dirty: null,
      lastErrorCode: code,
      lastErrorMessage: message,
      updatedAt: now().toISOString(),
    });

  const safelyCompensateCreate = async (
    record: WorktreeRecord,
    original: WorktreeServiceError,
    signal?: AbortSignal,
  ): Promise<void> => {
    try {
      const workspace = requireWorkspace(record.workspaceId);
      const entries = await options.git.list(workspace.repositoryPath, signal);
      const entry = exactEntry(entries, record);
      if (entry) {
        const exact = await inspectExactManagedWorktree(
          record,
          workspace,
          signal,
        );
        if (!exact || exact.head !== record.baseCommit) {
          setError(
            record.id,
            "WORKTREE_CREATE_FAILED",
            "Creation failed with ambiguous Git state; inspect it manually",
          );
          return;
        }
        await options.git.remove(workspace.repositoryPath, record.path, signal);
        const after = await options.git.list(workspace.repositoryPath, signal);
        if (exactEntry(after, record) || existsSync(record.path)) {
          setError(
            record.id,
            "WORKTREE_CREATE_FAILED",
            "Creation cleanup failed postcondition verification",
          );
          return;
        }
        const tip = await options.git.branchTip(
          workspace.repositoryPath,
          record.branchRef,
          signal,
        );
        if (tip !== record.baseCommit) {
          setError(
            record.id,
            "WORKTREE_CREATE_FAILED",
            "Creation failed and the managed branch moved; no branch cleanup was attempted",
          );
          return;
        }
        await options.git.deleteBranch(
          workspace.repositoryPath,
          record.branchRef,
          record.baseCommit,
          signal,
        );
      } else {
        if (existsSync(record.path)) {
          setError(
            record.id,
            "WORKTREE_CREATE_FAILED",
            "The allocated path exists but is not the recorded worktree",
          );
          return;
        }
        const tip = await options.git.branchTip(
          workspace.repositoryPath,
          record.branchRef,
          signal,
        );
        if (tip) {
          setError(
            record.id,
            "WORKTREE_CREATE_FAILED",
            "Creation failed with an unproven branch; no branch cleanup was attempted",
          );
          return;
        }
      }
      setError(record.id, original.code, original.message, "missing");
    } catch {
      setError(
        record.id,
        "WORKTREE_CREATE_FAILED",
        "Creation failed with ambiguous Git state; inspect it manually",
      );
    }
  };

  const service: WorktreeService = {
    async refs(workspaceId, query = "", limit = 50, signal) {
      const workspace = requireWorkspace(workspaceId);
      if (workspace.repositoryHealth !== "healthy") {
        throw new WorktreeServiceError(
          409,
          "WORKSPACE_UNHEALTHY",
          "Repository health must be restored before creating a worktree",
        );
      }
      const [head, refs] = await Promise.all([
        options.git.resolveHead(workspace.repositoryPath, signal),
        options.git.listRefs(
          workspace.repositoryPath,
          query,
          Math.min(100, Math.max(1, limit)),
          signal,
        ),
      ]);
      const signed = (ref: NonNullable<typeof head>) => {
        const snapshot = options.snapshots.sign(
          workspace.id,
          ref.fullName,
          ref.commit,
        );
        return {
          ...ref,
          baseSnapshotToken: snapshot.token,
          expiresAt: snapshot.expiresAt,
        };
      };
      return {
        head: head ? { ...signed(head), ref: head.fullName } : null,
        refs: refs.map(signed),
      };
    },
    list(workspaceId) {
      requireWorkspace(workspaceId);
      return options.repository.list(workspaceId).map(toDto);
    },
    get(id) {
      return toDto(requireRecord(id));
    },
    async create(workspaceId, input, idempotencyKey, signal) {
      const workspace = requireWorkspace(workspaceId);
      const hash = requestHash("create", { workspaceId, ...input });
      const started = beginOperation<WorktreeResponse>({
        type: "create",
        workspaceId,
        worktreeId: null,
        idempotencyKey,
        hash,
        requestJson: JSON.stringify({ workspaceId, ...input }),
      });
      if (started.prior) return started.prior;
      let record: WorktreeRecord | undefined;
      try {
        if (workspace.repositoryHealth !== "healthy") {
          throw new WorktreeServiceError(
            409,
            "WORKSPACE_UNHEALTHY",
            "Repository health must be restored before creating a worktree",
          );
        }
        const name = normalizeWorktreeName(input.name);
        const slug = validateWorktreeSlug(input.slug);
        if (
          !options.snapshots.verify(input.baseSnapshotToken, {
            workspaceId,
            ref: input.baseRef,
            commit: input.baseCommit,
          })
        ) {
          throw new WorktreeServiceError(
            409,
            "SNAPSHOT_INVALID",
            "Base snapshot expired or does not match this request",
          );
        }
        const worktreeId = createId();
        const allocated = allocateWorktreePath(
          options.managedRoot,
          workspace.id,
          worktreeId,
          slug,
        );
        const branchRef = deriveBranchRef(slug);
        await options.git.validateBranch(
          workspace.repositoryPath,
          branchRef,
          signal,
        );
        const timestamp = now().toISOString();
        const candidate: WorktreeRecord = {
          id: worktreeId,
          workspaceId,
          name,
          slug,
          path: allocated.path,
          branchRef,
          baseRef: input.baseRef,
          baseCommit: input.baseCommit,
          lifecycle: "creating",
          finalBranchTip: null,
          safetyTargetCommit: null,
          branchDeleted: false,
          health: "unknown",
          dirty: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        record = options.repository.transaction(() => {
          if (options.repository.slugExists(workspaceId, slug)) {
            throw new WorktreeServiceError(
              409,
              "CONFLICT",
              "A managed worktree already uses this slug",
            );
          }
          if (
            options.repository.branchExistsInCommonDir(
              workspace.gitCommonDir,
              branchRef,
            )
          ) {
            throw new WorktreeServiceError(
              409,
              "BRANCH_EXISTS",
              "The managed branch is already recorded for this repository",
            );
          }
          options.repository.create(candidate);
          options.repository.updateOperationWorktree(
            started.operation.id,
            worktreeId,
            timestamp,
          );
          return candidate;
        });

        await options.lock.runExclusive(workspace.gitCommonDir, async () => {
          if (
            await options.git.branchExists(
              workspace.repositoryPath,
              branchRef,
              signal,
            )
          ) {
            throw new WorktreeServiceError(
              409,
              "BRANCH_EXISTS",
              "The managed branch already exists",
            );
          }
          assertAllocatedPathAvailable(allocated);
          await options.git.add(
            workspace.repositoryPath,
            branchRef,
            allocated.path,
            input.baseCommit,
            signal,
          );
          assertCanonicalManagedPath(allocated);
          const entries = await options.git.list(
            workspace.repositoryPath,
            signal,
          );
          const entry = entries.find(
            (candidate) => candidate.path === allocated.path,
          );
          const commonDir = await options.git.commonDir(allocated.path, signal);
          if (
            !entry ||
            entry.branchRef !== branchRef ||
            entry.head !== input.baseCommit ||
            commonDir !== workspace.gitCommonDir
          ) {
            throw new WorktreeServiceError(
              500,
              "WORKTREE_CREATE_FAILED",
              "Created worktree failed postcondition verification",
            );
          }
        });
        const ready = options.repository.updateState(record.id, {
          lifecycle: "ready",
          health: "healthy",
          dirty: false,
          lastErrorCode: null,
          lastErrorMessage: null,
          updatedAt: now().toISOString(),
        })!;
        const response: WorktreeResponse = {
          operationId: started.operation.id,
          worktree: toDto(ready),
        };
        return complete(started.operation.id, 201, response);
      } catch (error) {
        const mapped = serviceError(error, "WORKTREE_CREATE_FAILED");
        if (record) {
          const workspace = requireWorkspace(record.workspaceId);
          try {
            await options.lock.runExclusive(workspace.gitCommonDir, () =>
              safelyCompensateCreate(record!, mapped, signal),
            );
          } catch {
            setError(
              record.id,
              "WORKTREE_CREATE_FAILED",
              "Creation failed with ambiguous Git state; inspect it manually",
            );
          }
        }
        return fail(started.operation.id, mapped);
      }
    },
    async remove(id, idempotencyKey, signal) {
      const initial = requireRecord(id);
      const hash = requestHash("remove", { id });
      const started = beginOperation<RemoveWorktreeResponse>({
        type: "remove",
        workspaceId: initial.workspaceId,
        worktreeId: id,
        idempotencyKey,
        hash,
        requestJson: JSON.stringify({ id }),
      });
      if (started.prior) return started.prior;
      const workspace = requireWorkspace(initial.workspaceId);
      try {
        if (initial.lifecycle !== "ready") {
          throw new WorktreeServiceError(
            409,
            "CONFLICT",
            "Only a ready managed worktree can be removed",
          );
        }
        if (!(await inspectExactManagedWorktree(initial, workspace, signal))) {
          throw new WorktreeServiceError(
            409,
            "WORKTREE_REMOVE_FAILED",
            "Recorded worktree no longer has its exact managed path and Git identity",
          );
        }
        const firstStatus = await options.git.status(initial.path, signal);
        options.repository.updateState(id, {
          dirty: firstStatus.dirty,
          updatedAt: now().toISOString(),
        });
        if (firstStatus.dirty) {
          throw new WorktreeServiceError(
            409,
            "WORKTREE_DIRTY",
            "Managed worktree has tracked or untracked changes",
            { tracked: firstStatus.tracked, untracked: firstStatus.untracked },
          );
        }
        const claimed = options.lifecycle.claimRemoval(id);
        if (!claimed) {
          throw new WorktreeServiceError(
            409,
            "CONFLICT",
            "Managed worktree lifecycle changed before removal",
          );
        }
        await stopRuntime(toDto(claimed));
        const removed = await options.lock.runExclusive(
          workspace.gitCommonDir,
          async () => {
            const exactBeforeRemoval = await inspectExactManagedWorktree(
              initial,
              workspace,
              signal,
            );
            if (!exactBeforeRemoval) {
              setError(
                id,
                "WORKTREE_REMOVE_FAILED",
                "Recorded worktree changed before removal",
                "git_mismatch",
              );
              throw new WorktreeServiceError(
                409,
                "WORKTREE_REMOVE_FAILED",
                "Recorded worktree changed before removal",
              );
            }
            const postStop = await options.git.status(initial.path, signal);
            if (postStop.dirty) {
              options.repository.updateState(id, {
                dirty: true,
                updatedAt: now().toISOString(),
              });
              options.lifecycle.restoreReady(id, {
                code: "WORKTREE_DIRTY",
                message:
                  "Worktree became dirty before removal and was left intact",
              });
              throw new WorktreeServiceError(
                409,
                "WORKTREE_DIRTY",
                "Managed worktree became dirty before removal",
                { tracked: postStop.tracked, untracked: postStop.untracked },
              );
            }
            const tip =
              (await options.git.branchTip(
                workspace.repositoryPath,
                initial.branchRef,
                signal,
              )) ?? exactBeforeRemoval.head!;
            options.repository.updateState(id, {
              finalBranchTip: tip,
              updatedAt: now().toISOString(),
            });
            try {
              await options.git.remove(
                workspace.repositoryPath,
                initial.path,
                signal,
              );
            } catch (error) {
              const intact = await inspectExactManagedWorktree(
                initial,
                workspace,
                signal,
              );
              if (intact) {
                options.lifecycle.restoreReady(id, {
                  code: "WORKTREE_REMOVE_FAILED",
                  message:
                    "Git left the worktree intact; retry after inspecting it",
                });
              } else {
                setError(
                  id,
                  "WORKTREE_REMOVE_FAILED",
                  "Removal failed with ambiguous Git state; inspect it manually",
                );
              }
              throw error;
            }
            const after = await options.git.list(
              workspace.repositoryPath,
              signal,
            );
            if (exactEntry(after, initial) || existsSync(initial.path)) {
              setError(
                id,
                "WORKTREE_REMOVE_FAILED",
                "Removal postcondition verification failed",
              );
              throw new WorktreeServiceError(
                500,
                "WORKTREE_REMOVE_FAILED",
                "Removal postcondition verification failed",
              );
            }
            return options.repository.updateState(id, {
              lifecycle: "removed",
              finalBranchTip: tip,
              health: "missing",
              dirty: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              updatedAt: now().toISOString(),
            })!;
          },
        );
        const response: RemoveWorktreeResponse = {
          operationId: started.operation.id,
          removed: true,
          tombstone: {
            branchRef: removed.branchRef,
            branchTip: removed.finalBranchTip!,
          },
          worktree: toDto(removed),
        };
        return complete(started.operation.id, 200, response);
      } catch (error) {
        const mapped = serviceError(error, "WORKTREE_REMOVE_FAILED");
        if (options.repository.get(id)?.lifecycle === "removing") {
          try {
            if (await inspectExactManagedWorktree(initial, workspace, signal)) {
              options.lifecycle.restoreReady(id, {
                code: mapped.code,
                message:
                  "Removal stopped before Git mutation and left the exact worktree intact",
              });
            } else {
              setError(
                id,
                "WORKTREE_REMOVE_FAILED",
                "Removal failed with ambiguous Git state; inspect it manually",
              );
            }
          } catch {
            setError(
              id,
              "WORKTREE_REMOVE_FAILED",
              "Removal failed and exact Git state could not be proven",
            );
          }
        }
        return fail(started.operation.id, mapped);
      }
    },
    async deleteBranch(id, input, idempotencyKey, signal) {
      const initial = requireRecord(id);
      const hash = requestHash("delete_branch", { id, ...input });
      const started = beginOperation<DeleteWorktreeBranchResponse>({
        type: "delete_branch",
        workspaceId: initial.workspaceId,
        worktreeId: id,
        idempotencyKey,
        hash,
        requestJson: JSON.stringify({ id, ...input }),
      });
      if (started.prior) return started.prior;
      try {
        if (
          initial.lifecycle !== "removed" ||
          !initial.finalBranchTip ||
          initial.branchDeleted
        ) {
          throw new WorktreeServiceError(
            409,
            "CONFLICT",
            "Branch deletion is available only after worktree removal",
          );
        }
        if (input.expectedBranchTip !== initial.finalBranchTip) {
          throw new WorktreeServiceError(
            409,
            "BRANCH_CHANGED",
            "Expected branch tip does not match the removal tombstone",
          );
        }
        const workspace = requireWorkspace(initial.workspaceId);
        const updated = await options.lock.runExclusive(
          workspace.gitCommonDir,
          async () => {
            const entries = await options.git.list(
              workspace.repositoryPath,
              signal,
            );
            if (
              entries.some((entry) => entry.branchRef === initial.branchRef)
            ) {
              throw new WorktreeServiceError(
                409,
                "BRANCH_CHANGED",
                "Another worktree is using the managed branch",
              );
            }
            const currentTip = await options.git.branchTip(
              workspace.repositoryPath,
              initial.branchRef,
              signal,
            );
            if (currentTip !== input.expectedBranchTip) {
              throw new WorktreeServiceError(
                409,
                "BRANCH_CHANGED",
                "Managed branch changed after worktree removal",
              );
            }
            const currentHead = await options.git.resolveHead(
              workspace.repositoryPath,
              signal,
            );
            if (
              !currentHead ||
              currentHead.commit !== input.safetyTargetCommit
            ) {
              throw new WorktreeServiceError(
                409,
                "BRANCH_CHANGED",
                "Workspace HEAD moved after the branch-deletion confirmation was prepared",
              );
            }
            const merged = await options.git.branchMergedInto(
              workspace.repositoryPath,
              currentTip,
              input.safetyTargetCommit,
              signal,
            );
            if (!merged) {
              throw new WorktreeServiceError(
                409,
                "BRANCH_NOT_MERGED",
                "Managed branch is not merged into the selected safety target",
              );
            }
            await options.git.deleteBranch(
              workspace.repositoryPath,
              initial.branchRef,
              currentTip,
              signal,
            );
            if (
              await options.git.branchExists(
                workspace.repositoryPath,
                initial.branchRef,
                signal,
              )
            ) {
              throw new WorktreeServiceError(
                409,
                "BRANCH_CHANGED",
                "Managed branch still exists after atomic deletion",
              );
            }
            return options.repository.updateState(id, {
              safetyTargetCommit: input.safetyTargetCommit,
              branchDeleted: true,
              lastErrorCode: null,
              lastErrorMessage: null,
              updatedAt: now().toISOString(),
            })!;
          },
        );
        const response: DeleteWorktreeBranchResponse = {
          operationId: started.operation.id,
          deleted: true,
          atomic: true,
          worktree: toDto(updated),
        };
        return complete(started.operation.id, 200, response);
      } catch (error) {
        return fail(
          started.operation.id,
          serviceError(error, "BRANCH_CHANGED"),
        );
      }
    },
    async reconcile(workspaceId) {
      const workspaceIds = workspaceId
        ? [requireWorkspace(workspaceId).id]
        : options.workspaces.list().map((workspace) => workspace.id);
      for (const id of workspaceIds) {
        const workspace = requireWorkspace(id);
        try {
          await options.lock.runExclusive(workspace.gitCommonDir, async () => {
            const worktrees = options.repository.list(id);
            const operations = options.repository.listInProgress(id);
            const liveWorktreeIds = new Set(
              operations
                .filter((operation) => activeOperations.has(operation.id))
                .map((operation) => operation.worktreeId)
                .filter((value): value is string => value !== null),
            );
            let entries: GitWorktreeListEntry[];
            try {
              entries = await options.git.list(workspace.repositoryPath);
            } catch {
              for (const record of worktrees) {
                if (record.lifecycle !== "removed") {
                  options.repository.updateState(record.id, {
                    health: "unknown",
                    dirty: null,
                    updatedAt: now().toISOString(),
                  });
                }
              }
              return;
            }

            for (const record of worktrees) {
              if (
                record.lifecycle === "removed" ||
                liveWorktreeIds.has(record.id)
              ) {
                continue;
              }
              const entry = exactEntry(entries, record);
              const pathExists = existsSync(record.path);
              let exact = false;
              if (
                entry &&
                entry.branchRef === record.branchRef &&
                hasExactManagedPath(record)
              ) {
                try {
                  exact =
                    (await options.git.commonDir(record.path)) ===
                    workspace.gitCommonDir;
                } catch {
                  exact = false;
                }
              }

              if (record.lifecycle === "creating") {
                if (exact && entry?.head === record.baseCommit) {
                  let status:
                    | Awaited<ReturnType<GitWorktreeManager["status"]>>
                    | undefined;
                  try {
                    status = await options.git.status(record.path);
                  } catch {
                    status = undefined;
                  }
                  const ready = options.repository.compareAndSetLifecycle(
                    record.id,
                    "creating",
                    "ready",
                    now().toISOString(),
                  );
                  if (ready) {
                    options.repository.updateState(record.id, {
                      health: status
                        ? entry.locked
                          ? "locked"
                          : "healthy"
                        : "unknown",
                      dirty: status?.dirty ?? null,
                      lastErrorCode: status ? null : "WORKTREE_CREATE_FAILED",
                      lastErrorMessage: status
                        ? null
                        : "Created worktree is exact, but status refresh failed",
                      updatedAt: now().toISOString(),
                    });
                  }
                } else {
                  setError(
                    record.id,
                    "WORKTREE_CREATE_FAILED",
                    "Creation was interrupted; inspect the allocated path and Git worktree list",
                    pathExists ? "git_mismatch" : "missing",
                  );
                }
              } else if (record.lifecycle === "removing") {
                if (!entry && !pathExists) {
                  if (!record.finalBranchTip) {
                    setError(
                      record.id,
                      "WORKTREE_REMOVE_FAILED",
                      "Removal completed without a durable final branch tip; inspect branch state manually",
                      "missing",
                    );
                  } else {
                    const removed = options.repository.compareAndSetLifecycle(
                      record.id,
                      "removing",
                      "removed",
                      now().toISOString(),
                    );
                    if (removed) {
                      options.repository.updateState(record.id, {
                        health: "missing",
                        dirty: null,
                        updatedAt: now().toISOString(),
                      });
                    }
                  }
                } else if (exact) {
                  options.lifecycle.restoreReady(record.id, {
                    code: "WORKTREE_REMOVE_FAILED",
                    message:
                      "Interrupted removal left the exact worktree intact; inspect and retry",
                  });
                } else {
                  setError(
                    record.id,
                    "WORKTREE_REMOVE_FAILED",
                    "Interrupted removal has ambiguous Git state; inspect it manually",
                  );
                }
              } else if (exact) {
                try {
                  const status = await options.git.status(record.path);
                  options.repository.updateState(record.id, {
                    health: entry!.locked ? "locked" : "healthy",
                    dirty: status.dirty,
                    updatedAt: now().toISOString(),
                  });
                } catch {
                  options.repository.updateState(record.id, {
                    health: "unknown",
                    dirty: null,
                    updatedAt: now().toISOString(),
                  });
                }
              } else {
                options.repository.updateState(record.id, {
                  health: pathExists ? "git_mismatch" : "missing",
                  dirty: null,
                  updatedAt: now().toISOString(),
                });
              }
            }

            for (const operation of operations) {
              if (activeOperations.has(operation.id)) continue;
              const record = operation.worktreeId
                ? options.repository.get(operation.worktreeId)
                : undefined;
              const timestamp = now().toISOString();
              if (!record) {
                options.repository.failOperation(
                  operation.id,
                  500,
                  operation.operationType === "create"
                    ? "WORKTREE_CREATE_FAILED"
                    : "WORKTREE_NOT_MANAGED",
                  "Interrupted operation has no managed worktree record",
                  timestamp,
                );
                continue;
              }
              if (operation.operationType === "create") {
                if (record.lifecycle === "ready") {
                  const response: WorktreeResponse = {
                    operationId: operation.id,
                    worktree: toDto(record),
                  };
                  options.repository.completeOperation(
                    operation.id,
                    201,
                    JSON.stringify(response),
                    timestamp,
                  );
                } else if (record.lifecycle === "error") {
                  options.repository.failOperation(
                    operation.id,
                    500,
                    "WORKTREE_CREATE_FAILED",
                    record.lastErrorMessage ??
                      "Interrupted creation failed reconciliation",
                    timestamp,
                  );
                }
              } else if (operation.operationType === "remove") {
                if (record.lifecycle === "removed" && record.finalBranchTip) {
                  const response: RemoveWorktreeResponse = {
                    operationId: operation.id,
                    removed: true,
                    tombstone: {
                      branchRef: record.branchRef,
                      branchTip: record.finalBranchTip,
                    },
                    worktree: toDto(record),
                  };
                  options.repository.completeOperation(
                    operation.id,
                    200,
                    JSON.stringify(response),
                    timestamp,
                  );
                } else if (
                  record.lifecycle === "ready" ||
                  record.lifecycle === "error"
                ) {
                  options.repository.failOperation(
                    operation.id,
                    409,
                    "WORKTREE_REMOVE_FAILED",
                    record.lastErrorMessage ??
                      "Interrupted removal was not completed",
                    timestamp,
                  );
                }
              } else if (record.branchDeleted) {
                const response: DeleteWorktreeBranchResponse = {
                  operationId: operation.id,
                  deleted: true,
                  atomic: true,
                  worktree: toDto(record),
                };
                options.repository.completeOperation(
                  operation.id,
                  200,
                  JSON.stringify(response),
                  timestamp,
                );
              } else {
                options.repository.failOperation(
                  operation.id,
                  409,
                  "BRANCH_CHANGED",
                  "Interrupted branch deletion could not be proven; inspect the ref before retrying",
                  timestamp,
                );
              }
            }
          });
        } catch (error) {
          if (error instanceof GitMutationBusyError) continue;
          throw error;
        }
      }
    },
  };
  return service;
}
