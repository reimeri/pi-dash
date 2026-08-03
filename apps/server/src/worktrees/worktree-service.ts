import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  ApiErrorCode,
  CreateWorktreeRequest,
  DeleteWorktreeBranchRequest,
  DeleteWorktreeBranchResponse,
  RemoveWorktreeRequest,
  RemoveWorktreeResponse,
  WorktreeRemovalInspection,
  WorktreeRemovalIssue,
  WorkspaceRefsResponse,
  WorktreeDiff,
  WorktreeDiffSummary,
  WorktreeDto,
  WorktreeResponse,
} from "@pi-dash/contracts";
import {
  GitDiffError,
  type GitDiffInspector,
  type GitDiffSnapshot,
  type GitDiffSummary,
} from "../git/git-diff-inspector.js";
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
  deriveAllocatedWorktreePath,
  deriveBranchRef,
  normalizeWorktreeName,
  validateWorktreeSlug,
  WorktreeValidationError,
} from "./worktree-validation.js";
import {
  allocatedPathIdentity,
  mountedPathsWithin,
  purgeQuarantinedPath,
  quarantineAllocatedPath,
} from "./managed-path-removal.js";
import type { RemovalConfirmationSigner } from "./removal-confirmation.js";

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
  if (error instanceof GitDiffError) {
    const status =
      error.code === "GIT_TIMEOUT"
        ? 504
        : error.code === "GIT_UNAVAILABLE"
          ? 503
          : error.code === "DIFF_TOO_LARGE" || error.code === "DIFF_CHANGED"
            ? 409
            : 500;
    return new WorktreeServiceError(status, error.code, error.message);
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
  diffSummary(id: string, signal?: AbortSignal): Promise<WorktreeDiffSummary>;
  diff(id: string, signal?: AbortSignal): Promise<WorktreeDiff>;
  verifyTerminalStart(id: string): Promise<WorktreeDto>;
  create(
    workspaceId: string,
    input: CreateWorktreeRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorktreeResponse>;
  prepareRemoval(
    id: string,
    signal?: AbortSignal,
  ): Promise<WorktreeRemovalInspection>;
  remove(
    id: string,
    input: RemoveWorktreeRequest,
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
  diffs: GitDiffInspector;
  lock: GitMutationLock;
  lifecycle: WorktreeLifecycleCoordinator;
  snapshots: BaseSnapshotSigner;
  removalConfirmations: RemovalConfirmationSigner;
  managedRoot: string;
  stopRuntime?: (worktree: WorktreeDto) => Promise<void>;
  onMembershipChange?: (change: {
    type: "upsert" | "removed";
    worktreeId: string;
    workspaceId: string;
  }) => void;
  now?: () => Date;
  id?: () => string;
}): WorktreeService {
  const now = options.now ?? (() => new Date());
  const createId = options.id ?? randomUUID;
  const stopRuntime = options.stopRuntime ?? (async () => undefined);
  const activeOperations = new Set<string>();
  const activeDiffInspections = new Set<string>();
  const publishMembership = (change: {
    type: "upsert" | "removed";
    worktreeId: string;
    workspaceId: string;
  }): void => {
    try {
      options.onMembershipChange?.(change);
    } catch {
      // Durable lifecycle changes must not be undone by event publication.
    }
  };

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

  type RemovalInspectionCore = Omit<
    WorktreeRemovalInspection,
    "checkedAt" | "confirmationToken" | "expiresAt"
  >;

  const inspectionHash = (inspection: RemovalInspectionCore): string =>
    createHash("sha256").update(JSON.stringify(inspection)).digest("hex");

  const inspectRemovalCore = async (
    record: WorktreeRecord,
    workspace: { repositoryPath: string; gitCommonDir: string },
    signal?: AbortSignal,
  ): Promise<RemovalInspectionCore> => {
    const allocated = deriveAllocatedWorktreePath(
      options.managedRoot,
      record.workspaceId,
      record.id,
      record.slug,
    );
    const issues: WorktreeRemovalIssue[] = [];
    const warnings: string[] = [];
    const issue = (
      code: WorktreeRemovalIssue["code"],
      summary: string,
      destructive = false,
    ) => issues.push({ code, summary, destructive });

    if (record.path !== allocated.path) {
      issue(
        "PATH_RECORD_MISMATCH",
        `Recorded path ${record.path} does not equal the deterministic allocation ${allocated.path}`,
      );
    }

    let pathExists = false;
    let pathKind: WorktreeRemovalInspection["observed"]["pathKind"] = "missing";
    let canonicalPath: string | null = null;
    try {
      const metadata = lstatSync(record.path);
      pathExists = true;
      pathKind = metadata.isSymbolicLink()
        ? "symlink"
        : metadata.isDirectory()
          ? "directory"
          : "other";
      if (pathKind === "directory") {
        try {
          canonicalPath = realpathSync(record.path);
        } catch {
          canonicalPath = null;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        pathKind = "unavailable";
        issue("INSPECTION_FAILED", "Managed path metadata could not be read");
      }
    }
    if (!pathExists) {
      issue("PATH_MISSING", `Managed path ${record.path} is missing`);
    } else if (pathKind !== "directory") {
      issue(
        "PATH_TYPE_CHANGED",
        `Managed path is now a ${pathKind}, not a directory`,
        true,
      );
    } else if (canonicalPath !== record.path) {
      issue(
        "PATH_CANONICAL_MISMATCH",
        `Managed path resolves to ${canonicalPath ?? "an unavailable location"}`,
        true,
      );
    }

    let entry: GitWorktreeListEntry | undefined;
    try {
      entry = exactEntry(
        await options.git.list(workspace.repositoryPath, signal),
        {
          ...record,
          path: allocated.path,
        },
      );
    } catch {
      issue(
        "INSPECTION_FAILED",
        "Git worktree metadata could not be inspected",
      );
    }
    if (!entry) {
      issue(
        "GIT_ENTRY_MISSING",
        `Git does not list a worktree at ${allocated.path}`,
      );
    }

    let observedCommonDir: string | null = null;
    if (pathExists) {
      try {
        observedCommonDir = await options.git.commonDir(record.path, signal);
      } catch {
        observedCommonDir = null;
      }
    }
    if (entry && observedCommonDir !== workspace.gitCommonDir) {
      issue(
        "COMMON_DIR_CHANGED",
        `Expected Git common directory ${workspace.gitCommonDir}, found ${observedCommonDir ?? "none"}`,
      );
    }
    if (entry?.detached) {
      issue("DETACHED_HEAD", "The managed worktree is now on detached HEAD");
    } else if (entry && entry.branchRef !== record.branchRef) {
      issue(
        "BRANCH_CHANGED",
        `Expected branch ${record.branchRef}, found ${entry.branchRef ?? "none"}`,
      );
    }
    if (entry && !entry.head) {
      issue("HEAD_UNAVAILABLE", "The worktree HEAD commit is unavailable");
    }
    if (entry?.locked) {
      issue(
        "WORKTREE_LOCKED",
        entry.lockReason
          ? `Git locked the worktree: ${entry.lockReason}`
          : "Git locked the worktree",
        true,
      );
    }

    let dirty: RemovalInspectionCore["dirty"] = {
      available: false,
      dirty: null,
      tracked: null,
      untracked: null,
    };
    if (pathKind === "directory") {
      try {
        const status = await options.git.status(record.path, signal);
        dirty = { available: true, ...status };
        if (status.dirty) {
          issue(
            "WORKTREE_DIRTY",
            `Worktree contains ${status.tracked} tracked and ${status.untracked} untracked changes`,
            true,
          );
        }
      } catch {
        issue("INSPECTION_FAILED", "Worktree changes could not be inspected");
      }
    }

    if (pathExists) {
      const mounts = await mountedPathsWithin(record.path);
      if (mounts.length > 0) {
        issue(
          "MOUNT_PRESENT",
          `Mounted content blocks removal: ${mounts.join(", ")}`,
        );
      }
    }

    const sameRepositoryEntry = Boolean(
      entry &&
      record.path === allocated.path &&
      pathKind === "directory" &&
      canonicalPath === record.path &&
      observedCommonDir === workspace.gitCommonDir,
    );
    const removalStrategy = sameRepositoryEntry ? "git" : "filesystem_only";
    let branchDisposition: RemovalInspectionCore["branchDisposition"];
    if (
      sameRepositoryEntry &&
      entry?.branchRef === record.branchRef &&
      entry.head
    ) {
      branchDisposition = {
        kind: "recorded",
        cleanupBranchRef: record.branchRef,
        untouchedBranchRefs: [],
      };
    } else if (
      sameRepositoryEntry &&
      entry?.branchRef?.startsWith("refs/heads/pi-dash/") &&
      entry.head &&
      !options.repository.branchOwnedByOther(
        workspace.gitCommonDir,
        entry.branchRef,
        record.id,
      )
    ) {
      branchDisposition = {
        kind: "adopt_observed",
        cleanupBranchRef: entry.branchRef,
        untouchedBranchRefs: [record.branchRef],
      };
      warnings.push(
        `The observed branch ${entry.branchRef} will become the managed cleanup branch; ${record.branchRef} will be left untouched`,
      );
    } else {
      const refs = [record.branchRef, entry?.branchRef]
        .filter((value): value is string => Boolean(value))
        .filter((value, index, values) => values.indexOf(value) === index);
      branchDisposition = {
        kind: "manual",
        cleanupBranchRef: null,
        untouchedBranchRefs: refs,
      };
      warnings.push(
        "Pi Dash cannot safely claim a cleanup branch; all Git refs will be left for manual management",
      );
    }
    if (removalStrategy === "filesystem_only") {
      branchDisposition = {
        kind: "manual",
        cleanupBranchRef: null,
        untouchedBranchRefs: branchDisposition.untouchedBranchRefs,
      };
      warnings.push(
        "Git metadata cannot be proven and will be left untouched after filesystem-only removal",
      );
    }

    const hardBlock =
      record.path !== allocated.path ||
      issues.some((candidate) => candidate.code === "MOUNT_PRESENT");
    const exactIdentity = Boolean(
      sameRepositoryEntry &&
      pathKind === "directory" &&
      canonicalPath === record.path &&
      entry?.branchRef === record.branchRef &&
      entry.head,
    );
    const safeRemovalAllowed = Boolean(
      record.lifecycle === "ready" &&
      exactIdentity &&
      dirty.available &&
      dirty.dirty === false &&
      !entry?.locked,
    );
    const forceRemovalAllowed =
      !hardBlock &&
      (record.lifecycle === "ready" || record.lifecycle === "error");

    return {
      worktreeId: record.id,
      safeRemovalAllowed,
      forceRemovalAllowed,
      expected: {
        path: record.path,
        allocatedPath: allocated.path,
        branchRef: record.branchRef,
        gitCommonDir: workspace.gitCommonDir,
      },
      observed: {
        pathExists,
        pathKind,
        canonicalPath,
        branchRef: entry?.branchRef ?? null,
        head: entry?.head ?? null,
        gitCommonDir: observedCommonDir,
        detached: entry?.detached ?? false,
        locked: entry?.locked ?? false,
        lockReason: entry?.lockReason ?? null,
        prunable: entry?.prunable ?? false,
      },
      dirty,
      branchDisposition,
      removalStrategy,
      issues,
      warnings,
    };
  };

  const prepareRemovalInspection = async (
    record: WorktreeRecord,
    workspace: { repositoryPath: string; gitCommonDir: string },
    signal?: AbortSignal,
  ): Promise<WorktreeRemovalInspection> => {
    const core = await inspectRemovalCore(record, workspace, signal);
    const confirmation = options.removalConfirmations.sign({
      worktreeId: record.id,
      recordUpdatedAt: record.updatedAt,
      inspectionHash: inspectionHash(core),
    });
    return {
      ...core,
      checkedAt: now().toISOString(),
      confirmationToken: confirmation.token,
      expiresAt: confirmation.expiresAt,
    };
  };

  const inspectDiff = async <T extends GitDiffSummary | GitDiffSnapshot>(
    id: string,
    operation: (path: string, signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (activeDiffInspections.has(id) || activeDiffInspections.size >= 4) {
      throw new WorktreeServiceError(
        409,
        "GIT_OPERATION_BUSY",
        "Diff inspection is already in progress",
      );
    }
    activeDiffInspections.add(id);
    try {
      const record = requireRecord(id);
      if (record.lifecycle !== "ready" || record.health !== "healthy") {
        throw new WorktreeServiceError(
          409,
          record.lifecycle === "ready"
            ? "WORKTREE_UNHEALTHY"
            : "WORKTREE_NOT_READY",
          "The managed worktree is no longer ready and healthy",
        );
      }
      const workspace = requireWorkspace(record.workspaceId);
      const before = await inspectExactManagedWorktree(
        record,
        workspace,
        signal,
      );
      if (!before || before.locked) {
        throw new WorktreeServiceError(
          409,
          "WORKTREE_UNHEALTHY",
          "The managed worktree no longer has its exact Git identity",
        );
      }
      let result: T;
      try {
        result = await operation(record.path, signal);
      } catch (error) {
        throw serviceError(error, "DIFF_FAILED");
      }
      const after = await inspectExactManagedWorktree(
        record,
        workspace,
        signal,
      );
      if (!after || after.locked || after.head !== result.headCommit) {
        throw new WorktreeServiceError(
          409,
          "DIFF_CHANGED",
          "Worktree HEAD changed while its diff was being inspected",
        );
      }
      return result;
    } finally {
      activeDiffInspections.delete(id);
    }
  };

  const existingOperationResult = <T>(
    existing: WorktreeOperationRecord,
    hash: string,
  ): T => {
    if (existing.requestHash !== hash) {
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
    return JSON.parse(existing.resultJson!) as T;
  };

  const replayOperation = <T>(
    idempotencyKey: string,
    hash: string,
  ): T | undefined => {
    const existing = options.repository.findOperation(idempotencyKey);
    return existing ? existingOperationResult<T>(existing, hash) : undefined;
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
        return {
          operation: existing,
          prior: existingOperationResult<T>(existing, input.hash),
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
    const completed = options.repository.completeOperation(
      operationId,
      status,
      JSON.stringify(result),
      now().toISOString(),
    );
    if (!completed) {
      throw new Error("Operation is no longer in progress");
    }
    activeOperations.delete(operationId);
    return result;
  };
  const fail = (operationId: string, error: WorktreeServiceError): never => {
    options.repository.failOperation(
      operationId,
      error.statusCode,
      error.code,
      error.message,
      now().toISOString(),
    );
    activeOperations.delete(operationId);
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
    async diffSummary(id, signal) {
      const result = await inspectDiff(
        id,
        (path, currentSignal) => options.diffs.summary(path, currentSignal),
        signal,
      );
      return {
        worktreeId: id,
        ...result,
        checkedAt: now().toISOString(),
      };
    },
    async diff(id, signal) {
      const result = await inspectDiff(
        id,
        (path, currentSignal) => options.diffs.snapshot(path, currentSignal),
        signal,
      );
      return {
        worktreeId: id,
        ...result,
        checkedAt: now().toISOString(),
      };
    },
    async verifyTerminalStart(id) {
      const record = requireRecord(id);
      if (record.lifecycle !== "ready" || record.health !== "healthy") {
        throw new WorktreeServiceError(
          409,
          record.lifecycle === "ready"
            ? "WORKTREE_UNHEALTHY"
            : "WORKTREE_NOT_READY",
          "The managed worktree is no longer ready and healthy",
        );
      }
      const workspace = requireWorkspace(record.workspaceId);
      const entry = await inspectExactManagedWorktree(record, workspace);
      if (!entry || entry.locked) {
        throw new WorktreeServiceError(
          409,
          "WORKTREE_UNHEALTHY",
          "The managed worktree no longer has its exact Git identity",
        );
      }
      return toDto(record);
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
        publishMembership({
          type: "upsert",
          worktreeId: record.id,
          workspaceId: record.workspaceId,
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
    async prepareRemoval(id, signal) {
      const record = requireRecord(id);
      if (record.lifecycle !== "ready" && record.lifecycle !== "error") {
        throw new WorktreeServiceError(
          409,
          "WORKTREE_NOT_READY",
          "Only a ready or recoverable managed worktree can be inspected for removal",
        );
      }
      return prepareRemovalInspection(
        record,
        requireWorkspace(record.workspaceId),
        signal,
      );
    },
    async remove(id, input, idempotencyKey, signal) {
      const hash = requestHash("remove", { id, ...input });
      const replay = replayOperation<RemoveWorktreeResponse>(
        idempotencyKey,
        hash,
      );
      if (replay) return replay;
      if (input.mode === "force" && input.confirmation !== "delete") {
        throw new WorktreeServiceError(
          400,
          "WORKTREE_REMOVAL_CONFIRMATION_INVALID",
          'Forced removal requires the exact confirmation "delete"',
        );
      }
      const initial = requireRecord(id);
      const workspace = requireWorkspace(initial.workspaceId);
      const inspected = await inspectRemovalCore(initial, workspace, signal);
      const confirmationValid = options.removalConfirmations.verify(
        input.confirmationToken,
        {
          worktreeId: initial.id,
          recordUpdatedAt: initial.updatedAt,
          inspectionHash: inspectionHash(inspected),
        },
      );
      if (!confirmationValid) {
        throw new WorktreeServiceError(
          409,
          "WORKTREE_REMOVAL_CHANGED",
          "Worktree state changed or the removal confirmation expired; review it again",
          await prepareRemovalInspection(initial, workspace, signal),
        );
      }
      if (input.mode === "safe" && !inspected.safeRemovalAllowed) {
        throw new WorktreeServiceError(
          409,
          inspected.dirty.dirty ? "WORKTREE_DIRTY" : "WORKTREE_REMOVE_FAILED",
          inspected.issues[0]?.summary ??
            "Safe removal is no longer allowed for this worktree",
          await prepareRemovalInspection(initial, workspace, signal),
        );
      }
      if (input.mode === "force" && !inspected.forceRemovalAllowed) {
        throw new WorktreeServiceError(
          409,
          "WORKTREE_FORCE_BLOCKED",
          inspected.issues[0]?.summary ?? "Forced removal is blocked",
          await prepareRemovalInspection(initial, workspace, signal),
        );
      }

      const started = beginOperation<RemoveWorktreeResponse>({
        type: "remove",
        workspaceId: initial.workspaceId,
        worktreeId: id,
        idempotencyKey,
        hash,
        requestJson: JSON.stringify({ id, ...input }),
      });
      if (started.prior) return started.prior;
      let claimedByOperation = false;
      try {
        const timestamp = now().toISOString();
        const allocated = deriveAllocatedWorktreePath(
          options.managedRoot,
          initial.workspaceId,
          initial.id,
          initial.slug,
        );
        const identity = await allocatedPathIdentity(initial.path);
        const expectedQuarantinePath = resolve(
          allocated.workspaceRoot,
          ".pi-dash-trash",
          started.operation.id,
        );
        options.repository.createRemovalJournal({
          operationId: started.operation.id,
          workspaceId: initial.workspaceId,
          worktreeId: initial.id,
          mode: input.mode,
          priorLifecycle: initial.lifecycle === "error" ? "error" : "ready",
          strategy: inspected.removalStrategy,
          phase: "prepared",
          originalPath: initial.path,
          quarantinePath:
            inspected.removalStrategy === "filesystem_only" && identity
              ? expectedQuarantinePath
              : null,
          originalDevice: identity?.device ?? null,
          originalInode: identity?.inode ?? null,
          originalKind: identity?.kind ?? null,
          recordedBranchRef: initial.branchRef,
          cleanupBranchRef: inspected.branchDisposition.cleanupBranchRef,
          cleanupBranchTip: null,
          inspectionJson: JSON.stringify(inspected),
          warningsJson: JSON.stringify(inspected.warnings),
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        const claimed =
          initial.lifecycle === "ready"
            ? options.lifecycle.claimRemoval(id)
            : options.repository.compareAndSetLifecycle(
                id,
                "error",
                "removing",
                now().toISOString(),
              );
        if (!claimed) {
          throw new WorktreeServiceError(
            409,
            "WORKTREE_REMOVAL_CHANGED",
            "Managed worktree lifecycle changed before removal",
          );
        }
        claimedByOperation = true;
        await stopRuntime(toDto(claimed));

        const result = await options.lock.runExclusive(
          workspace.gitCommonDir,
          async (): Promise<RemoveWorktreeResponse> => {
            const fresh = await inspectRemovalCore(initial, workspace, signal);
            const authorizationStillValid = options.removalConfirmations.verify(
              input.confirmationToken,
              {
                worktreeId: initial.id,
                recordUpdatedAt: initial.updatedAt,
                inspectionHash: inspectionHash(fresh),
              },
            );
            if (
              !authorizationStillValid ||
              inspectionHash(fresh) !== inspectionHash(inspected)
            ) {
              throw new WorktreeServiceError(
                409,
                "WORKTREE_REMOVAL_CHANGED",
                "Worktree state changed after confirmation; review it again",
                await prepareRemovalInspection(initial, workspace, signal),
              );
            }
            if (
              fresh.issues.some(
                (candidate) => candidate.code === "MOUNT_PRESENT",
              )
            ) {
              throw new WorktreeServiceError(
                409,
                "WORKTREE_FORCE_BLOCKED",
                "Mounted content blocks worktree removal",
              );
            }

            const cleanupRef = fresh.branchDisposition.cleanupBranchRef;
            let cleanupTip: string | null = null;
            if (cleanupRef) {
              cleanupTip = fresh.observed.head;
              const resolvedTip = await options.git.branchTip(
                workspace.repositoryPath,
                cleanupRef,
                signal,
              );
              if (!cleanupTip || resolvedTip !== cleanupTip) {
                throw new WorktreeServiceError(
                  409,
                  "WORKTREE_REMOVAL_CHANGED",
                  `Cleanup branch ${cleanupRef} changed before removal`,
                );
              }
            }
            options.repository.updateRemovalJournal(started.operation.id, {
              phase: "mutation_started",
              cleanupBranchRef: cleanupRef,
              cleanupBranchTip: cleanupTip,
              updatedAt: now().toISOString(),
            });

            if (fresh.removalStrategy === "git") {
              const force =
                input.mode === "safe"
                  ? "none"
                  : fresh.observed.locked
                    ? "locked"
                    : "dirty";
              await options.git.remove(
                workspace.repositoryPath,
                initial.path,
                undefined,
                force,
              );
            } else if (identity) {
              const quarantinePath = await quarantineAllocatedPath({
                path: initial.path,
                workspaceRoot: allocated.workspaceRoot,
                operationId: started.operation.id,
                expectedIdentity: identity,
              });
              options.repository.updateRemovalJournal(started.operation.id, {
                phase: "quarantined",
                quarantinePath,
                updatedAt: now().toISOString(),
              });
              await purgeQuarantinedPath({
                path: quarantinePath,
                workspaceRoot: allocated.workspaceRoot,
                operationId: started.operation.id,
                expectedIdentity: identity,
              });
              options.repository.updateRemovalJournal(started.operation.id, {
                phase: "purged",
                updatedAt: now().toISOString(),
              });
            }

            if (existsSync(initial.path)) {
              throw new WorktreeServiceError(
                500,
                "WORKTREE_REMOVE_FAILED",
                "Removal postcondition failed because the allocated path still exists",
              );
            }
            if (fresh.removalStrategy === "git") {
              const after = await options.git.list(workspace.repositoryPath);
              if (after.some((entry) => entry.path === initial.path)) {
                throw new WorktreeServiceError(
                  500,
                  "WORKTREE_REMOVE_FAILED",
                  "Git still reports the removed worktree",
                );
              }
            }

            if (cleanupRef && cleanupTip) {
              const removed = options.repository.updateState(id, {
                lifecycle: "removed",
                branchRef: cleanupRef,
                finalBranchTip: cleanupTip,
                health: "missing",
                dirty: null,
                lastErrorCode: null,
                lastErrorMessage: null,
                updatedAt: now().toISOString(),
              })!;
              options.repository.updateRemovalJournal(started.operation.id, {
                phase: "finalized",
                updatedAt: now().toISOString(),
              });
              return {
                operationId: started.operation.id,
                removed: true,
                outcome: "removed_with_branch_cleanup",
                branchCleanup: {
                  branchRef: cleanupRef,
                  branchTip: cleanupTip,
                },
                warnings: fresh.warnings,
                worktree: toDto(removed),
              };
            }

            const warnings =
              fresh.warnings.length > 0
                ? fresh.warnings
                : ["Git branches and metadata were left for manual management"];
            const response: RemoveWorktreeResponse = {
              operationId: started.operation.id,
              removed: true,
              outcome: "forgotten",
              branchCleanup: null,
              warnings,
              worktreeId: initial.id,
              workspaceId: initial.workspaceId,
            };
            options.repository.finalizeForgottenRemoval({
              operationId: started.operation.id,
              worktreeId: initial.id,
              resultJson: JSON.stringify(response),
              updatedAt: now().toISOString(),
            });
            activeOperations.delete(started.operation.id);
            return response;
          },
        );

        publishMembership({
          type: result.outcome === "forgotten" ? "removed" : "upsert",
          worktreeId: initial.id,
          workspaceId: initial.workspaceId,
        });
        return result.outcome === "forgotten"
          ? result
          : complete(started.operation.id, 200, result);
      } catch (error) {
        const mapped = serviceError(error, "WORKTREE_REMOVE_FAILED");
        const journal = options.repository.getRemovalJournal(
          started.operation.id,
        );
        const current = options.repository.get(id);
        if (claimedByOperation && current?.lifecycle === "removing") {
          if (existsSync(initial.path)) {
            if (initial.lifecycle === "ready") {
              options.lifecycle.restoreReady(id, {
                code: mapped.code,
                message:
                  "Removal was stopped and the allocated path remains intact",
              });
            } else {
              setError(
                id,
                mapped.code,
                "Removal was stopped and the recoverable path remains intact",
                current.health,
              );
            }
          } else {
            setError(
              id,
              "WORKTREE_REMOVE_FAILED",
              "Removal was interrupted after filesystem mutation; reconciliation will resume it",
              "missing",
            );
          }
        }
        if (
          journal &&
          (journal.phase === "quarantined" ||
            journal.phase === "purged" ||
            (journal.phase === "mutation_started" && !existsSync(initial.path)))
        ) {
          activeOperations.delete(started.operation.id);
          throw new WorktreeServiceError(
            409,
            "OPERATION_IN_PROGRESS",
            "Removal reached filesystem mutation and will be finalized by reconciliation",
            { operationId: started.operation.id, worktreeId: initial.id },
          );
        }
        options.repository.updateRemovalJournal(started.operation.id, {
          phase: "finalized",
          updatedAt: now().toISOString(),
        });
        return fail(started.operation.id, mapped);
      }
    },
    async deleteBranch(id, input, idempotencyKey, signal) {
      const hash = requestHash("delete_branch", { id, ...input });
      const replay = replayOperation<DeleteWorktreeBranchResponse>(
        idempotencyKey,
        hash,
      );
      if (replay) return replay;
      const initial = requireRecord(id);
      const started = beginOperation<DeleteWorktreeBranchResponse>({
        type: "delete_branch",
        workspaceId: initial.workspaceId,
        worktreeId: id,
        idempotencyKey,
        hash,
        requestJson: JSON.stringify({ id, ...input }),
      });
      if (started.prior) return started.prior;
      let deletionAttempted = false;
      try {
        if (initial.lifecycle !== "removed" || !initial.finalBranchTip) {
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
        const response: DeleteWorktreeBranchResponse = {
          operationId: started.operation.id,
          deleted: true,
          atomic: true,
          worktreeId: initial.id,
          workspaceId: initial.workspaceId,
        };
        await options.lock.runExclusive(workspace.gitCommonDir, async () => {
          const entries = await options.git.list(
            workspace.repositoryPath,
            signal,
          );
          if (entries.some((entry) => entry.branchRef === initial.branchRef)) {
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
          if (!currentHead || currentHead.commit !== input.safetyTargetCommit) {
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
          try {
            await options.git.deleteBranch(
              workspace.repositoryPath,
              initial.branchRef,
              currentTip,
              signal,
            );
            deletionAttempted = true;
          } catch (error) {
            try {
              deletionAttempted = !(await options.git.branchExists(
                workspace.repositoryPath,
                initial.branchRef,
              ));
            } catch {
              deletionAttempted = true;
            }
            throw error;
          }
          options.repository.finalizeBranchDeletion({
            operationId: started.operation.id,
            worktreeId: initial.id,
            expectedBranchTip: currentTip,
            resultJson: JSON.stringify(response),
            updatedAt: now().toISOString(),
          });
          activeOperations.delete(started.operation.id);
        });
        publishMembership({
          type: "removed",
          worktreeId: initial.id,
          workspaceId: initial.workspaceId,
        });
        return response;
      } catch (error) {
        if (deletionAttempted) {
          activeOperations.delete(started.operation.id);
          throw new WorktreeServiceError(
            409,
            "OPERATION_IN_PROGRESS",
            "Branch deletion reached Git and will be finalized by reconciliation",
            { operationId: started.operation.id, worktreeId: initial.id },
          );
        }
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
            const removalJournals =
              options.repository.listIncompleteRemovalJournals(id);
            const recoveredOperationIds = new Set<string>();
            for (const journal of removalJournals) {
              if (
                journal.phase !== "prepared" ||
                activeOperations.has(journal.operationId)
              ) {
                continue;
              }
              const record = options.repository.get(journal.worktreeId);
              if (record?.lifecycle === "removing") {
                if (journal.priorLifecycle === "ready") {
                  options.lifecycle.restoreReady(record.id, {
                    code: "WORKTREE_REMOVE_FAILED",
                    message:
                      "Interrupted removal stopped before filesystem mutation; inspect and retry",
                  });
                } else {
                  setError(
                    record.id,
                    "WORKTREE_REMOVE_FAILED",
                    "Interrupted forced removal stopped before filesystem mutation; inspect and retry",
                    record.health,
                  );
                }
              }
              options.repository.failOperation(
                journal.operationId,
                409,
                "WORKTREE_REMOVE_FAILED",
                "Interrupted removal stopped before filesystem mutation",
                now().toISOString(),
              );
              options.repository.updateRemovalJournal(journal.operationId, {
                phase: "finalized",
                updatedAt: now().toISOString(),
              });
              recoveredOperationIds.add(journal.operationId);
            }
            for (const journal of removalJournals) {
              if (
                journal.strategy !== "filesystem_only" ||
                activeOperations.has(journal.operationId) ||
                journal.phase === "prepared"
              ) {
                continue;
              }
              const record = options.repository.get(journal.worktreeId);
              if (!record) continue;
              try {
                if (
                  journal.phase === "mutation_started" &&
                  existsSync(journal.originalPath) &&
                  (!journal.quarantinePath ||
                    !existsSync(journal.quarantinePath))
                ) {
                  const allocated = deriveAllocatedWorktreePath(
                    options.managedRoot,
                    record.workspaceId,
                    record.id,
                    record.slug,
                  );
                  const currentIdentity = await allocatedPathIdentity(
                    journal.originalPath,
                  );
                  const originalIsIntact = Boolean(
                    journal.originalPath === allocated.path &&
                    currentIdentity &&
                    journal.originalDevice === currentIdentity.device &&
                    journal.originalInode === currentIdentity.inode &&
                    journal.originalKind === currentIdentity.kind,
                  );
                  if (!originalIsIntact) {
                    setError(
                      record.id,
                      "WORKTREE_REMOVE_FAILED",
                      "Interrupted filesystem removal no longer has its confirmed allocation identity",
                      "git_mismatch",
                    );
                    continue;
                  }
                  if (journal.priorLifecycle === "ready") {
                    options.lifecycle.restoreReady(record.id, {
                      code: "WORKTREE_REMOVE_FAILED",
                      message:
                        "Interrupted filesystem removal stopped before quarantine; inspect and retry",
                    });
                  } else {
                    setError(
                      record.id,
                      "WORKTREE_REMOVE_FAILED",
                      "Interrupted filesystem removal stopped before quarantine; inspect and retry",
                      record.health,
                    );
                  }
                  options.repository.failOperation(
                    journal.operationId,
                    409,
                    "WORKTREE_REMOVE_FAILED",
                    "Interrupted filesystem removal stopped before quarantine",
                    now().toISOString(),
                  );
                  options.repository.updateRemovalJournal(journal.operationId, {
                    phase: "finalized",
                    updatedAt: now().toISOString(),
                  });
                  recoveredOperationIds.add(journal.operationId);
                  continue;
                }
                if (
                  journal.quarantinePath &&
                  existsSync(journal.quarantinePath)
                ) {
                  if (
                    !journal.originalDevice ||
                    !journal.originalInode ||
                    !journal.originalKind
                  ) {
                    throw new Error(
                      "Removal journal has no trusted quarantine identity",
                    );
                  }
                  const allocated = deriveAllocatedWorktreePath(
                    options.managedRoot,
                    record.workspaceId,
                    record.id,
                    record.slug,
                  );
                  await purgeQuarantinedPath({
                    path: journal.quarantinePath,
                    workspaceRoot: allocated.workspaceRoot,
                    operationId: journal.operationId,
                    expectedIdentity: {
                      device: journal.originalDevice,
                      inode: journal.originalInode,
                      kind: journal.originalKind,
                    },
                  });
                  options.repository.updateRemovalJournal(journal.operationId, {
                    phase: "purged",
                    updatedAt: now().toISOString(),
                  });
                }
                if (
                  !existsSync(journal.originalPath) &&
                  (!journal.quarantinePath ||
                    !existsSync(journal.quarantinePath))
                ) {
                  let warnings: string[];
                  try {
                    warnings = JSON.parse(journal.warningsJson) as string[];
                  } catch {
                    warnings = [];
                  }
                  if (warnings.length === 0) {
                    warnings = [
                      "Git branches and metadata were left for manual management",
                    ];
                  }
                  const response: RemoveWorktreeResponse = {
                    operationId: journal.operationId,
                    removed: true,
                    outcome: "forgotten",
                    branchCleanup: null,
                    warnings,
                    worktreeId: journal.worktreeId,
                    workspaceId: journal.workspaceId,
                  };
                  options.repository.finalizeForgottenRemoval({
                    operationId: journal.operationId,
                    worktreeId: journal.worktreeId,
                    resultJson: JSON.stringify(response),
                    updatedAt: now().toISOString(),
                  });
                  recoveredOperationIds.add(journal.operationId);
                  publishMembership({
                    type: "removed",
                    worktreeId: journal.worktreeId,
                    workspaceId: journal.workspaceId,
                  });
                }
              } catch {
                setError(
                  journal.worktreeId,
                  "WORKTREE_REMOVE_FAILED",
                  "Quarantined worktree removal could not be resumed",
                  "missing",
                );
              }
            }
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

            for (const journal of removalJournals) {
              if (
                journal.strategy !== "git" ||
                activeOperations.has(journal.operationId) ||
                journal.phase === "prepared" ||
                recoveredOperationIds.has(journal.operationId)
              ) {
                continue;
              }
              const record = options.repository.get(journal.worktreeId);
              if (!record) continue;
              const originalExists = existsSync(journal.originalPath);
              const gitEntryExists = entries.some(
                (entry) => entry.path === journal.originalPath,
              );
              if (originalExists || gitEntryExists) {
                if (originalExists && gitEntryExists) {
                  if (journal.priorLifecycle === "ready") {
                    options.lifecycle.restoreReady(record.id, {
                      code: "WORKTREE_REMOVE_FAILED",
                      message:
                        "Interrupted Git removal left the worktree intact; inspect and retry",
                    });
                  } else {
                    setError(
                      record.id,
                      "WORKTREE_REMOVE_FAILED",
                      "Interrupted forced Git removal left the worktree intact; inspect and retry",
                      record.health,
                    );
                  }
                  options.repository.failOperation(
                    journal.operationId,
                    409,
                    "WORKTREE_REMOVE_FAILED",
                    "Interrupted Git removal left the worktree intact",
                    now().toISOString(),
                  );
                  options.repository.updateRemovalJournal(journal.operationId, {
                    phase: "finalized",
                    updatedAt: now().toISOString(),
                  });
                  recoveredOperationIds.add(journal.operationId);
                }
                continue;
              }
              if (journal.cleanupBranchRef && journal.cleanupBranchTip) {
                const removed = options.repository.updateState(record.id, {
                  lifecycle: "removed",
                  branchRef: journal.cleanupBranchRef,
                  finalBranchTip: journal.cleanupBranchTip,
                  health: "missing",
                  dirty: null,
                  lastErrorCode: null,
                  lastErrorMessage: null,
                  updatedAt: now().toISOString(),
                })!;
                let warnings: string[] = [];
                try {
                  warnings = JSON.parse(journal.warningsJson) as string[];
                } catch {
                  warnings = [];
                }
                const response: RemoveWorktreeResponse = {
                  operationId: journal.operationId,
                  removed: true,
                  outcome: "removed_with_branch_cleanup",
                  branchCleanup: {
                    branchRef: journal.cleanupBranchRef,
                    branchTip: journal.cleanupBranchTip,
                  },
                  warnings,
                  worktree: toDto(removed),
                };
                options.repository.completeOperation(
                  journal.operationId,
                  200,
                  JSON.stringify(response),
                  now().toISOString(),
                );
                options.repository.updateRemovalJournal(journal.operationId, {
                  phase: "finalized",
                  updatedAt: now().toISOString(),
                });
                recoveredOperationIds.add(journal.operationId);
                publishMembership({
                  type: "upsert",
                  worktreeId: removed.id,
                  workspaceId: removed.workspaceId,
                });
              } else {
                let warnings: string[];
                try {
                  warnings = JSON.parse(journal.warningsJson) as string[];
                } catch {
                  warnings = [];
                }
                if (warnings.length === 0) {
                  warnings = [
                    "Git branches and metadata were left for manual management",
                  ];
                }
                const response: RemoveWorktreeResponse = {
                  operationId: journal.operationId,
                  removed: true,
                  outcome: "forgotten",
                  branchCleanup: null,
                  warnings,
                  worktreeId: journal.worktreeId,
                  workspaceId: journal.workspaceId,
                };
                options.repository.finalizeForgottenRemoval({
                  operationId: journal.operationId,
                  worktreeId: journal.worktreeId,
                  resultJson: JSON.stringify(response),
                  updatedAt: now().toISOString(),
                });
                recoveredOperationIds.add(journal.operationId);
                publishMembership({
                  type: "removed",
                  worktreeId: journal.worktreeId,
                  workspaceId: journal.workspaceId,
                });
              }
            }

            const recoveredWorktreeIds = new Set(
              removalJournals
                .filter((journal) =>
                  recoveredOperationIds.has(journal.operationId),
                )
                .map((journal) => journal.worktreeId),
            );
            for (const record of worktrees) {
              if (
                record.lifecycle === "removed" ||
                liveWorktreeIds.has(record.id) ||
                recoveredWorktreeIds.has(record.id)
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
                      publishMembership({
                        type: "upsert",
                        worktreeId: removed.id,
                        workspaceId: removed.workspaceId,
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
              if (
                activeOperations.has(operation.id) ||
                recoveredOperationIds.has(operation.id)
              ) {
                continue;
              }
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
                  const journal = options.repository.getRemovalJournal(
                    operation.id,
                  );
                  let warnings: string[] = [];
                  try {
                    warnings = journal
                      ? (JSON.parse(journal.warningsJson) as string[])
                      : [];
                  } catch {
                    warnings = [];
                  }
                  const response: RemoveWorktreeResponse = {
                    operationId: operation.id,
                    removed: true,
                    outcome: "removed_with_branch_cleanup",
                    branchCleanup: {
                      branchRef: record.branchRef,
                      branchTip: record.finalBranchTip,
                    },
                    warnings,
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
              } else {
                let expectedBranchTip: string | undefined;
                try {
                  const request = JSON.parse(operation.requestJson) as {
                    expectedBranchTip?: unknown;
                  };
                  if (typeof request.expectedBranchTip === "string") {
                    expectedBranchTip = request.expectedBranchTip;
                  }
                } catch {
                  expectedBranchTip = undefined;
                }
                let branchExists: boolean;
                try {
                  branchExists = await options.git.branchExists(
                    workspace.repositoryPath,
                    record.branchRef,
                  );
                } catch {
                  continue;
                }
                if (
                  record.lifecycle === "removed" &&
                  record.finalBranchTip &&
                  expectedBranchTip === record.finalBranchTip &&
                  !branchExists
                ) {
                  const response: DeleteWorktreeBranchResponse = {
                    operationId: operation.id,
                    deleted: true,
                    atomic: true,
                    worktreeId: record.id,
                    workspaceId: record.workspaceId,
                  };
                  options.repository.finalizeBranchDeletion({
                    operationId: operation.id,
                    worktreeId: record.id,
                    expectedBranchTip: record.finalBranchTip,
                    resultJson: JSON.stringify(response),
                    updatedAt: timestamp,
                  });
                  publishMembership({
                    type: "removed",
                    worktreeId: record.id,
                    workspaceId: record.workspaceId,
                  });
                } else {
                  options.repository.failOperation(
                    operation.id,
                    409,
                    "BRANCH_CHANGED",
                    "Interrupted branch deletion did not reach the expected absent-branch postcondition",
                    timestamp,
                  );
                }
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
