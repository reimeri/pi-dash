export const PROTOCOL_VERSION = 0 as const;
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;
export const MIN_COLS = 2;
export const MAX_COLS = 500;
export const MIN_ROWS = 1;
export const MAX_ROWS = 300;

export type ClientFrame =
  | { v: 0; type: "input"; data: string }
  | { v: 0; type: "binaryInput"; dataBase64: string }
  | { v: 0; type: "resize"; cols: number; rows: number }
  | { v: 0; type: "replayFrom"; seq: number };

export type RuntimeState = "running" | "exited";
export type AttentionState = "idle" | "working" | "blocked" | "done";

export type ServerFrame =
  | { v: 0; type: "hello"; runtimeId: string; earliestSeq: number; latestSeq: number }
  | { v: 0; type: "output"; seq: number; data: string }
  | { v: 0; type: "replayReset"; earliestSeq: number; latestSeq: number }
  | { v: 0; type: "runtime"; state: RuntimeState; exitCode: number | null }
  | {
      v: 0;
      type: "status";
      event: StatusEventName;
      state: AttentionState;
      capability: "waiting" | "connected" | "degraded";
    }
  | { v: 0; type: "error"; code: string; message: string };

export const STATUS_EVENTS = [
  "session_start",
  "agent_start",
  "blocking_wait_start",
  "blocking_wait_end",
  "agent_settled",
  "session_shutdown",
] as const;
export type StatusEventName = (typeof STATUS_EVENTS)[number];

export interface StatusEventFrame {
  v: 0;
  runtimeId: string;
  token: string;
  event: StatusEventName;
  interactionId?: string;
  reason?: string;
}

export type ClientFrameResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

export function parseClientFrame(text: string): ClientFrameResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: "INVALID_JSON", message: "Frame must be valid JSON." };
  }
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION || typeof value.type !== "string") {
    return { ok: false, code: "INVALID_FRAME", message: "Frame must use protocol version 0 and a known type." };
  }

  switch (value.type) {
    case "input":
      return hasExactKeys(value, ["v", "type", "data"]) && typeof value.data === "string"
        ? { ok: true, frame: value as ClientFrame }
        : { ok: false, code: "INVALID_INPUT", message: "Input data must be a string." };
    case "binaryInput":
      return hasExactKeys(value, ["v", "type", "dataBase64"]) &&
        typeof value.dataBase64 === "string" &&
        isCanonicalBase64(value.dataBase64)
        ? { ok: true, frame: value as ClientFrame }
        : { ok: false, code: "INVALID_BINARY_INPUT", message: "Binary input must be canonical Base64." };
    case "resize":
      return hasExactKeys(value, ["v", "type", "cols", "rows"]) &&
        isIntegerInRange(value.cols, MIN_COLS, MAX_COLS) &&
        isIntegerInRange(value.rows, MIN_ROWS, MAX_ROWS)
        ? { ok: true, frame: value as ClientFrame }
        : {
            ok: false,
            code: "INVALID_RESIZE",
            message: `Resize must use integer columns ${MIN_COLS}-${MAX_COLS} and rows ${MIN_ROWS}-${MAX_ROWS}.`,
          };
    case "replayFrom":
      return hasExactKeys(value, ["v", "type", "seq"]) && isIntegerInRange(value.seq, 1, Number.MAX_SAFE_INTEGER)
        ? { ok: true, frame: value as ClientFrame }
        : { ok: false, code: "INVALID_REPLAY", message: "Replay sequence must be a positive safe integer." };
    default:
      return { ok: false, code: "UNKNOWN_FRAME", message: "Unknown client frame type." };
  }
}

export function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

export function encodeBinaryInput(data: string): string {
  let binary = "";
  for (let index = 0; index < data.length; index++) binary += String.fromCharCode(data.charCodeAt(index) & 0xff);
  return btoa(binary);
}

export function isServerFrame(value: unknown): value is ServerFrame {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION || typeof value.type !== "string") return false;
  switch (value.type) {
    case "hello":
      return typeof value.runtimeId === "string" && Number.isSafeInteger(value.earliestSeq) && Number.isSafeInteger(value.latestSeq);
    case "output":
      return Number.isSafeInteger(value.seq) && typeof value.data === "string";
    case "replayReset":
      return Number.isSafeInteger(value.earliestSeq) && Number.isSafeInteger(value.latestSeq);
    case "runtime":
      return (value.state === "running" || value.state === "exited") && (value.exitCode === null || Number.isInteger(value.exitCode));
    case "status":
      return (
        STATUS_EVENTS.includes(value.event as StatusEventName) &&
        ["idle", "working", "blocked", "done"].includes(String(value.state)) &&
        ["waiting", "connected", "degraded"].includes(String(value.capability))
      );
    case "error":
      return typeof value.code === "string" && typeof value.message === "string";
    default:
      return false;
  }
}
