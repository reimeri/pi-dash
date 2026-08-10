import { Type, type Static } from "@sinclair/typebox";
import { WorkspaceSchema } from "./workspaces.js";
import { RuntimeSchema, ShellActivitySchema } from "./terminal.js";

export const STATUS_PROTOCOL_VERSION = 1 as const;
export const STATUS_MAX_FRAME_BYTES = 16 * 1024;
export const APPLICATION_EVENTS_PROTOCOL_VERSION = 8 as const;

const UuidSchema = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const TimestampSchema = Type.String({ minLength: 20, maxLength: 35 });

export const WorkflowStateSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("working"),
  Type.Literal("blocked"),
  Type.Literal("done"),
]);
export type WorkflowState = Static<typeof WorkflowStateSchema>;

export const WorkflowReasonSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("ask_user"),
  Type.Literal("settled"),
  Type.Literal("acknowledged"),
  Type.Literal("runtime_reset"),
  Type.Null(),
]);
export type WorkflowReason = Static<typeof WorkflowReasonSchema>;

export const StatusIntegrationSchema = Type.Union([
  Type.Literal("connected"),
  Type.Literal("disconnected"),
  Type.Literal("unsupported"),
]);
export type StatusIntegration = Static<typeof StatusIntegrationSchema>;

export const WorkflowStatusSchema = Type.Object(
  {
    worktreeId: UuidSchema,
    state: WorkflowStateSchema,
    reason: WorkflowReasonSchema,
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    changedAt: TimestampSchema,
    acknowledgedAt: Type.Union([TimestampSchema, Type.Null()]),
    integration: StatusIntegrationSchema,
  },
  { additionalProperties: false },
);
export type WorkflowStatusDto = Static<typeof WorkflowStatusSchema>;

const StatusFrameBase = {
  v: Type.Literal(STATUS_PROTOCOL_VERSION),
  runtimeId: UuidSchema,
  worktreeId: UuidSchema,
  token: Type.String({ minLength: 32, maxLength: 512 }),
  extensionInstanceId: UuidSchema,
  seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  timestamp: TimestampSchema,
};

const LifecycleEventSchema = Type.Union([
  Type.Literal("session_start"),
  Type.Literal("session_shutdown"),
  Type.Literal("agent_start"),
]);

export const StatusExtensionFrameSchema = Type.Union([
  Type.Object(
    {
      ...StatusFrameBase,
      kind: Type.Literal("event"),
      event: LifecycleEventSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StatusFrameBase,
      kind: Type.Literal("event"),
      event: Type.Literal("agent_settled"),
      completionId: UuidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StatusFrameBase,
      kind: Type.Literal("event"),
      event: Type.Union([
        Type.Literal("blocking_wait_start"),
        Type.Literal("blocking_wait_end"),
      ]),
      interactionId: UuidSchema,
      reason: Type.Literal("ask_user"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StatusFrameBase,
      kind: Type.Literal("snapshot"),
      agentActive: Type.Boolean(),
      blockingInteractions: Type.Array(
        Type.Object(
          { id: UuidSchema, reason: Type.Literal("ask_user") },
          { additionalProperties: false },
        ),
        { maxItems: 32, uniqueItems: true },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type StatusExtensionFrame = Static<typeof StatusExtensionFrameSchema>;

export const StatusAcknowledgeRequestSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);
export type StatusAcknowledgeRequest = Static<
  typeof StatusAcknowledgeRequestSchema
>;

export const StatusAcknowledgeResponseSchema = Type.Object(
  { status: WorkflowStatusSchema, acknowledged: Type.Boolean() },
  { additionalProperties: false },
);
export type StatusAcknowledgeResponse = Static<
  typeof StatusAcknowledgeResponseSchema
>;

export const WorkspaceAttentionSchema = Type.Object(
  {
    workspaceId: UuidSchema,
    state: WorkflowStateSchema,
    count: Type.Integer({ minimum: 0 }),
    integration: StatusIntegrationSchema,
  },
  { additionalProperties: false },
);
export type WorkspaceAttentionDto = Static<typeof WorkspaceAttentionSchema>;

export const WorkspaceEnvironmentChangeSchema = Type.Object(
  {
    workspaceId: UuidSchema,
    affectedRuntimes: Type.Array(
      Type.Object(
        {
          worktreeId: UuidSchema,
          runtimeId: UuidSchema,
          kind: Type.Union([Type.Literal("pi"), Type.Literal("shell")]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
export type WorkspaceEnvironmentChangeDto = Static<
  typeof WorkspaceEnvironmentChangeSchema
>;

export const ApplicationEventsClientFrameSchema = Type.Object(
  {
    v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
    type: Type.Literal("subscribe"),
    afterCursor: Type.Optional(
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ),
  },
  { additionalProperties: false },
);
export type ApplicationEventsClientFrame = Static<
  typeof ApplicationEventsClientFrameSchema
>;

export const ApplicationEventsServerFrameSchema = Type.Union([
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("snapshot"),
      cursor: Type.Integer({ minimum: 0 }),
      statuses: Type.Array(WorkflowStatusSchema),
      runtimes: Type.Array(RuntimeSchema),
      shellActivities: Type.Array(ShellActivitySchema),
      workspaceAttention: Type.Array(WorkspaceAttentionSchema),
      environmentChanges: Type.Array(WorkspaceEnvironmentChangeSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("status"),
      cursor: Type.Integer({ minimum: 1 }),
      status: WorkflowStatusSchema,
      workspaceAttention: Type.Array(WorkspaceAttentionSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("shellActivity"),
      cursor: Type.Integer({ minimum: 1 }),
      activity: ShellActivitySchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("worktreeRemoved"),
      cursor: Type.Integer({ minimum: 1 }),
      worktreeId: UuidSchema,
      workspaceId: UuidSchema,
      workspaceAttention: Type.Array(WorkspaceAttentionSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("workspaceUpdated"),
      cursor: Type.Integer({ minimum: 1 }),
      workspace: WorkspaceSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("workspaceOrderUpdated"),
      cursor: Type.Integer({ minimum: 1 }),
      workspaceIds: Type.Array(UuidSchema, { maxItems: 50 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("workspaceEnvironmentChanged"),
      cursor: Type.Integer({ minimum: 1 }),
      workspaceId: UuidSchema,
      environmentChanges: Type.Array(WorkspaceEnvironmentChangeSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("runtime"),
      cursor: Type.Integer({ minimum: 1 }),
      runtime: RuntimeSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(APPLICATION_EVENTS_PROTOCOL_VERSION),
      type: Type.Literal("resyncRequired"),
      latestCursor: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
]);
export type ApplicationEventsServerFrame = Static<
  typeof ApplicationEventsServerFrameSchema
>;
