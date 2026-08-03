import { Type, type Static } from "@sinclair/typebox";

const UuidSchema = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const ObjectIdSchema = Type.String({
  pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
});

export const WorktreeLifecycleSchema = Type.Union([
  Type.Literal("creating"),
  Type.Literal("ready"),
  Type.Literal("removing"),
  Type.Literal("removed"),
  Type.Literal("error"),
]);
export type WorktreeLifecycle = Static<typeof WorktreeLifecycleSchema>;

export const WorktreeHealthSchema = Type.Union([
  Type.Literal("healthy"),
  Type.Literal("missing"),
  Type.Literal("git_mismatch"),
  Type.Literal("locked"),
  Type.Literal("unknown"),
]);
export type WorktreeHealth = Static<typeof WorktreeHealthSchema>;

export const WorktreeSchema = Type.Object(
  {
    id: UuidSchema,
    workspaceId: UuidSchema,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    slug: Type.String({
      minLength: 1,
      maxLength: 72,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    }),
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    branchRef: Type.String({ minLength: 12, maxLength: 1024 }),
    baseRef: Type.String({ minLength: 1, maxLength: 1024 }),
    baseCommit: ObjectIdSchema,
    lifecycle: WorktreeLifecycleSchema,
    finalBranchTip: Type.Union([ObjectIdSchema, Type.Null()]),
    health: WorktreeHealthSchema,
    dirty: Type.Union([Type.Boolean(), Type.Null()]),
    lastError: Type.Optional(
      Type.Object(
        {
          code: Type.String({ minLength: 1, maxLength: 80 }),
          message: Type.String({ minLength: 1, maxLength: 500 }),
        },
        { additionalProperties: false },
      ),
    ),
    createdAt: Type.String({ minLength: 20, maxLength: 35 }),
    updatedAt: Type.String({ minLength: 20, maxLength: 35 }),
  },
  { additionalProperties: false },
);
export type WorktreeDto = Static<typeof WorktreeSchema>;

const GitRefProperties = {
  name: Type.String({ minLength: 1, maxLength: 1024 }),
  fullName: Type.String({ minLength: 1, maxLength: 1024 }),
  commit: ObjectIdSchema,
  kind: Type.Union([Type.Literal("local"), Type.Literal("tag")]),
  baseSnapshotToken: Type.String({ minLength: 32, maxLength: 2048 }),
  expiresAt: Type.String({ minLength: 20, maxLength: 35 }),
};

export const GitRefSchema = Type.Object(GitRefProperties, {
  additionalProperties: false,
});
export type GitRefDto = Static<typeof GitRefSchema>;

export const WorkspaceRefsQuerySchema = Type.Object(
  {
    query: Type.Optional(Type.String({ maxLength: 200 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export type WorkspaceRefsQuery = Static<typeof WorkspaceRefsQuerySchema>;

export const WorkspaceRefsResponseSchema = Type.Object(
  {
    head: Type.Union([
      Type.Object(
        {
          ...GitRefProperties,
          ref: Type.String({ minLength: 1, maxLength: 1024 }),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    refs: Type.Array(GitRefSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type WorkspaceRefsResponse = Static<typeof WorkspaceRefsResponseSchema>;

export const CreateWorktreeRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    slug: Type.String({ minLength: 1, maxLength: 72 }),
    baseRef: Type.String({ minLength: 1, maxLength: 1024 }),
    baseCommit: ObjectIdSchema,
    baseSnapshotToken: Type.String({ minLength: 32, maxLength: 2048 }),
  },
  { additionalProperties: false },
);
export type CreateWorktreeRequest = Static<typeof CreateWorktreeRequestSchema>;

export const WorktreeResponseSchema = Type.Object(
  { operationId: UuidSchema, worktree: WorktreeSchema },
  { additionalProperties: false },
);
export type WorktreeResponse = Static<typeof WorktreeResponseSchema>;

export const WorktreeListResponseSchema = Type.Object(
  { worktrees: Type.Array(WorktreeSchema) },
  { additionalProperties: false },
);
export type WorktreeListResponse = Static<typeof WorktreeListResponseSchema>;

export const WorktreeIdParamsSchema = Type.Object(
  { id: UuidSchema },
  { additionalProperties: false },
);
export type WorktreeIdParams = Static<typeof WorktreeIdParamsSchema>;

export const EmptyObjectSchema = Type.Object(
  {},
  { additionalProperties: false },
);
export type EmptyObject = Static<typeof EmptyObjectSchema>;

export const WorktreeRemovalIssueCodeSchema = Type.Union([
  Type.Literal("PATH_RECORD_MISMATCH"),
  Type.Literal("PATH_MISSING"),
  Type.Literal("PATH_TYPE_CHANGED"),
  Type.Literal("PATH_CANONICAL_MISMATCH"),
  Type.Literal("GIT_ENTRY_MISSING"),
  Type.Literal("BRANCH_CHANGED"),
  Type.Literal("DETACHED_HEAD"),
  Type.Literal("COMMON_DIR_CHANGED"),
  Type.Literal("HEAD_UNAVAILABLE"),
  Type.Literal("WORKTREE_DIRTY"),
  Type.Literal("WORKTREE_LOCKED"),
  Type.Literal("MOUNT_PRESENT"),
  Type.Literal("INSPECTION_FAILED"),
]);
export type WorktreeRemovalIssueCode = Static<
  typeof WorktreeRemovalIssueCodeSchema
>;

export const WorktreeRemovalIssueSchema = Type.Object(
  {
    code: WorktreeRemovalIssueCodeSchema,
    summary: Type.String({ minLength: 1, maxLength: 500 }),
    destructive: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type WorktreeRemovalIssue = Static<typeof WorktreeRemovalIssueSchema>;

export const WorktreeRemovalInspectionSchema = Type.Object(
  {
    worktreeId: UuidSchema,
    checkedAt: Type.String({ minLength: 20, maxLength: 35 }),
    confirmationToken: Type.String({ minLength: 32, maxLength: 8192 }),
    expiresAt: Type.String({ minLength: 20, maxLength: 35 }),
    safeRemovalAllowed: Type.Boolean(),
    forceRemovalAllowed: Type.Boolean(),
    expected: Type.Object(
      {
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        allocatedPath: Type.String({ minLength: 1, maxLength: 4096 }),
        branchRef: Type.String({ minLength: 12, maxLength: 1024 }),
        gitCommonDir: Type.String({ minLength: 1, maxLength: 4096 }),
      },
      { additionalProperties: false },
    ),
    observed: Type.Object(
      {
        pathExists: Type.Boolean(),
        pathKind: Type.Union([
          Type.Literal("directory"),
          Type.Literal("symlink"),
          Type.Literal("other"),
          Type.Literal("missing"),
          Type.Literal("unavailable"),
        ]),
        canonicalPath: Type.Union([
          Type.String({ minLength: 1, maxLength: 4096 }),
          Type.Null(),
        ]),
        branchRef: Type.Union([
          Type.String({ minLength: 12, maxLength: 1024 }),
          Type.Null(),
        ]),
        head: Type.Union([ObjectIdSchema, Type.Null()]),
        gitCommonDir: Type.Union([
          Type.String({ minLength: 1, maxLength: 4096 }),
          Type.Null(),
        ]),
        detached: Type.Boolean(),
        locked: Type.Boolean(),
        lockReason: Type.Union([
          Type.String({ minLength: 1, maxLength: 500 }),
          Type.Null(),
        ]),
        prunable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    dirty: Type.Object(
      {
        available: Type.Boolean(),
        dirty: Type.Union([Type.Boolean(), Type.Null()]),
        tracked: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        untracked: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    branchDisposition: Type.Object(
      {
        kind: Type.Union([
          Type.Literal("recorded"),
          Type.Literal("adopt_observed"),
          Type.Literal("manual"),
        ]),
        cleanupBranchRef: Type.Union([
          Type.String({ minLength: 12, maxLength: 1024 }),
          Type.Null(),
        ]),
        untouchedBranchRefs: Type.Array(
          Type.String({ minLength: 12, maxLength: 1024 }),
          { maxItems: 2 },
        ),
      },
      { additionalProperties: false },
    ),
    removalStrategy: Type.Union([
      Type.Literal("git"),
      Type.Literal("filesystem_only"),
    ]),
    issues: Type.Array(WorktreeRemovalIssueSchema, { maxItems: 20 }),
    warnings: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      maxItems: 20,
    }),
  },
  { additionalProperties: false },
);
export type WorktreeRemovalInspection = Static<
  typeof WorktreeRemovalInspectionSchema
>;

export const RemoveWorktreeRequestSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("safe"), Type.Literal("force")]),
    confirmationToken: Type.String({ minLength: 32, maxLength: 8192 }),
    confirmation: Type.Optional(Type.Literal("delete")),
  },
  { additionalProperties: false },
);
export type RemoveWorktreeRequest = Static<typeof RemoveWorktreeRequestSchema>;

const BranchCleanupSchema = Type.Object(
  {
    branchRef: Type.String({ minLength: 12, maxLength: 1024 }),
    branchTip: ObjectIdSchema,
  },
  { additionalProperties: false },
);

export const RemoveWorktreeResponseSchema = Type.Union([
  Type.Object(
    {
      operationId: UuidSchema,
      removed: Type.Literal(true),
      outcome: Type.Literal("removed_with_branch_cleanup"),
      branchCleanup: BranchCleanupSchema,
      warnings: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
        maxItems: 20,
      }),
      worktree: WorktreeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operationId: UuidSchema,
      removed: Type.Literal(true),
      outcome: Type.Literal("forgotten"),
      branchCleanup: Type.Null(),
      warnings: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
        minItems: 1,
        maxItems: 20,
      }),
      worktreeId: UuidSchema,
      workspaceId: UuidSchema,
    },
    { additionalProperties: false },
  ),
]);
export type RemoveWorktreeResponse = Static<
  typeof RemoveWorktreeResponseSchema
>;

export const DeleteWorktreeBranchRequestSchema = Type.Object(
  {
    expectedBranchTip: ObjectIdSchema,
    safetyTargetCommit: ObjectIdSchema,
  },
  { additionalProperties: false },
);
export type DeleteWorktreeBranchRequest = Static<
  typeof DeleteWorktreeBranchRequestSchema
>;

export const DeleteWorktreeBranchResponseSchema = Type.Object(
  {
    operationId: UuidSchema,
    deleted: Type.Literal(true),
    atomic: Type.Literal(true),
    worktreeId: UuidSchema,
    workspaceId: UuidSchema,
  },
  { additionalProperties: false },
);
export type DeleteWorktreeBranchResponse = Static<
  typeof DeleteWorktreeBranchResponseSchema
>;
