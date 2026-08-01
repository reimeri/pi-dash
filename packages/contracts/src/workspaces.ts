import { Type, type Static } from "@sinclair/typebox";

export const RepositoryHealthSchema = Type.Union([
  Type.Literal("healthy"),
  Type.Literal("missing"),
  Type.Literal("inaccessible"),
  Type.Literal("not_git"),
  Type.Literal("changed"),
]);
export type RepositoryHealth = Static<typeof RepositoryHealthSchema>;

export const WorkspaceRepositorySchema = Type.Object(
  {
    health: RepositoryHealthSchema,
    currentBranch: Type.Union([Type.String(), Type.Null()]),
    headCommit: Type.Union([Type.String(), Type.Null()]),
    checkedAt: Type.Union([
      Type.String({ minLength: 20, maxLength: 35 }),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const WorkspaceSchema = Type.Object(
  {
    id: Type.String({
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    slug: Type.String({
      minLength: 1,
      maxLength: 80,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    }),
    repositoryPath: Type.String({ minLength: 1, maxLength: 4096 }),
    repository: WorkspaceRepositorySchema,
    worktreeCount: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ minLength: 20, maxLength: 35 }),
    updatedAt: Type.String({ minLength: 20, maxLength: 35 }),
  },
  { additionalProperties: false },
);
export type WorkspaceDto = Static<typeof WorkspaceSchema>;
export type WorkspaceSummaryDto = WorkspaceDto;

export const WorkspaceListResponseSchema = Type.Object(
  { workspaces: Type.Array(WorkspaceSchema) },
  { additionalProperties: false },
);
export type WorkspaceListResponse = Static<typeof WorkspaceListResponseSchema>;

export const WorkspaceResponseSchema = Type.Object(
  { workspace: WorkspaceSchema },
  { additionalProperties: false },
);
export type WorkspaceResponse = Static<typeof WorkspaceResponseSchema>;

export const WorkspaceIdParamsSchema = Type.Object(
  {
    id: Type.String({
      pattern:
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
    }),
  },
  { additionalProperties: false },
);
export type WorkspaceIdParams = Static<typeof WorkspaceIdParamsSchema>;

export const WorkspacePathRequestSchema = Type.Object(
  { path: Type.String({ minLength: 1, maxLength: 4096 }) },
  { additionalProperties: false },
);
export type WorkspacePathRequest = Static<typeof WorkspacePathRequestSchema>;

export const WorkspacePreviewResponseSchema = Type.Object(
  {
    repositoryPath: Type.String({ minLength: 1, maxLength: 4096 }),
    defaultName: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
export type WorkspacePreviewResponse = Static<
  typeof WorkspacePreviewResponseSchema
>;

export const CreateWorkspaceRequestSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
export type CreateWorkspaceRequest = Static<
  typeof CreateWorkspaceRequestSchema
>;

export const RenameWorkspaceRequestSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);
export type RenameWorkspaceRequest = Static<
  typeof RenameWorkspaceRequestSchema
>;

export const NativeDialogAdapterSchema = Type.Union([
  Type.Literal("zenity"),
  Type.Literal("kdialog"),
]);
export type NativeDialogAdapter = Static<typeof NativeDialogAdapterSchema>;

export const DirectoryDialogResponseSchema = Type.Object(
  {
    cancelled: Type.Boolean(),
    path: Type.Union([
      Type.String({ minLength: 1, maxLength: 4096 }),
      Type.Null(),
    ]),
    adapter: NativeDialogAdapterSchema,
  },
  { additionalProperties: false },
);
export type DirectoryDialogResponse = Static<
  typeof DirectoryDialogResponseSchema
>;
