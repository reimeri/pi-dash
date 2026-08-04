import { Type, type Static } from "@sinclair/typebox";

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const TERMINAL_MIN_COLS = 2;
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MIN_ROWS = 1;
export const TERMINAL_MAX_ROWS = 300;

const UuidSchema = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
});
const TimestampSchema = Type.String({ minLength: 20, maxLength: 35 });

export const TerminalRuntimeStateSchema = Type.Union([
  Type.Literal("stopped"),
  Type.Literal("starting"),
  Type.Literal("running"),
  Type.Literal("stopping"),
  Type.Literal("crashed"),
]);
export type TerminalRuntimeState = Static<typeof TerminalRuntimeStateSchema>;

export const RuntimeSchema = Type.Object(
  {
    worktreeId: UuidSchema,
    runtimeId: Type.Union([UuidSchema, Type.Null()]),
    state: TerminalRuntimeStateSchema,
    startedAt: Type.Union([TimestampSchema, Type.Null()]),
    exitedAt: Type.Union([TimestampSchema, Type.Null()]),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([Type.Integer(), Type.Null()]),
    attachedClients: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type RuntimeDto = Static<typeof RuntimeSchema>;

export const ShellActivitySchema = Type.Object(
  {
    worktreeId: UuidSchema,
    runtimeId: Type.Union([UuidSchema, Type.Null()]),
    foregroundCommandActive: Type.Boolean(),
    changedAt: TimestampSchema,
  },
  { additionalProperties: false },
);
export type ShellActivityDto = Static<typeof ShellActivitySchema>;

export const RuntimeResponseSchema = Type.Object(
  { runtime: RuntimeSchema },
  { additionalProperties: false },
);
export type RuntimeResponse = Static<typeof RuntimeResponseSchema>;

export const RestartRuntimeResponseSchema = Type.Object(
  { operationId: UuidSchema, runtime: RuntimeSchema },
  { additionalProperties: false },
);
export type RestartRuntimeResponse = Static<
  typeof RestartRuntimeResponseSchema
>;

export const TerminalClientFrameSchema = Type.Union([
  Type.Object(
    {
      v: Type.Literal(TERMINAL_PROTOCOL_VERSION),
      type: Type.Literal("attach"),
      afterSeq: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(TERMINAL_PROTOCOL_VERSION),
      type: Type.Literal("input"),
      data: Type.String({ maxLength: 65_536 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(TERMINAL_PROTOCOL_VERSION),
      type: Type.Literal("binaryInput"),
      dataBase64: Type.String({ maxLength: 87_384 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(TERMINAL_PROTOCOL_VERSION),
      type: Type.Literal("resize"),
      cols: Type.Integer({
        minimum: TERMINAL_MIN_COLS,
        maximum: TERMINAL_MAX_COLS,
      }),
      rows: Type.Integer({
        minimum: TERMINAL_MIN_ROWS,
        maximum: TERMINAL_MAX_ROWS,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      v: Type.Literal(TERMINAL_PROTOCOL_VERSION),
      type: Type.Literal("ping"),
      nonce: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
]);
export type TerminalClientFrame = Static<typeof TerminalClientFrameSchema>;

export type TerminalServerFrame =
  | {
      v: 1;
      type: "hello";
      runtime: RuntimeDto;
      connectionId: string;
      inputOwner: boolean;
      earliestSeq: number;
      latestSeq: number;
    }
  | { v: 1; type: "output"; seq: number; data: string; replay: boolean }
  | { v: 1; type: "replayReset"; earliestSeq: number; latestSeq: number }
  | {
      v: 1;
      type: "runtime";
      state: TerminalRuntimeState;
      exitCode: number | null;
      signal: number | null;
    }
  | { v: 1; type: "pong"; nonce: string }
  | { v: 1; type: "error"; code: string; message: string };
