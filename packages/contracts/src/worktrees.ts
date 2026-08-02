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

export const RemoveWorktreeResponseSchema = Type.Object(
  {
    operationId: UuidSchema,
    removed: Type.Literal(true),
    tombstone: Type.Object(
      {
        branchRef: Type.String({ minLength: 12, maxLength: 1024 }),
        branchTip: ObjectIdSchema,
      },
      { additionalProperties: false },
    ),
    worktree: WorktreeSchema,
  },
  { additionalProperties: false },
);
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
