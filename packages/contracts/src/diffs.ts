import { Type, type Static } from "@sinclair/typebox";

const UuidSchema = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const ObjectIdSchema = Type.String({
  pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$",
});
const SnapshotIdSchema = Type.String({ pattern: "^[0-9a-f]{64}$" });
const CountSchema = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });

const WorktreeDiffSummaryProperties = {
  worktreeId: UuidSchema,
  headCommit: ObjectIdSchema,
  snapshotId: SnapshotIdSchema,
  hasChanges: Type.Boolean(),
  filesChanged: CountSchema,
  additions: CountSchema,
  deletions: CountSchema,
  binaryFiles: CountSchema,
  checkedAt: Type.String({ minLength: 20, maxLength: 35 }),
};

export const WorktreeDiffSummarySchema = Type.Object(
  WorktreeDiffSummaryProperties,
  { additionalProperties: false },
);
export type WorktreeDiffSummary = Static<typeof WorktreeDiffSummarySchema>;

export const DiffOmissionReasonSchema = Type.Union([
  Type.Literal("file-limit"),
  Type.Literal("patch-too-large"),
  Type.Literal("unsupported-file"),
]);
export type DiffOmissionReason = Static<typeof DiffOmissionReasonSchema>;

export const DiffOmittedFileSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    reason: DiffOmissionReasonSchema,
  },
  { additionalProperties: false },
);
export type DiffOmittedFile = Static<typeof DiffOmittedFileSchema>;

export const WorktreeDiffSchema = Type.Object(
  {
    ...WorktreeDiffSummaryProperties,
    patch: Type.String({ maxLength: 5 * 1024 * 1024 }),
    truncated: Type.Boolean(),
    omittedFiles: Type.Array(DiffOmittedFileSchema, { maxItems: 10_000 }),
  },
  { additionalProperties: false },
);
export type WorktreeDiff = Static<typeof WorktreeDiffSchema>;
