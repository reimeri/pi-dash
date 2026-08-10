import {
  RuntimeSchema,
  TERMINAL_PROTOCOL_VERSION,
  type RuntimeDto,
  type TerminalServerFrame,
} from "@pi-dash/contracts";
import { Value } from "@sinclair/typebox/value";

export const SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";
export const ALT_ENTER_SEQUENCE = "\u001b[13;3u";

function csiU(codepoint: number, modifier: number): string {
  return `\u001b[${codepoint};${modifier + 1}u`;
}

export function translateTerminalKey(
  event: Pick<
    KeyboardEvent,
    "type" | "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
): string | null {
  if (event.type !== "keydown" || event.metaKey) return null;
  if (event.key === "Enter" && !event.ctrlKey) {
    if (event.shiftKey && !event.altKey) return SHIFT_ENTER_SEQUENCE;
    if (event.altKey && !event.shiftKey) return ALT_ENTER_SEQUENCE;
    return null;
  }
  if (
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    event.key.length === 1 &&
    !["c", "v"].includes(event.key.toLowerCase())
  ) {
    const codepoint = event.key.toLowerCase().codePointAt(0);
    if (codepoint === undefined) return null;
    const baseLayout = /^Key[A-Z]$/.test(event.code)
      ? event.code.slice(3).toLowerCase().codePointAt(0)
      : undefined;
    return baseLayout !== undefined && baseLayout !== codepoint
      ? `\u001b[${codepoint}::${baseLayout};6u`
      : csiU(codepoint, 5);
  }
  return null;
}

export function encodeBinaryInput(data: string): string {
  let binary = "";
  for (let index = 0; index < data.length; index += 1) {
    binary += String.fromCharCode(data.charCodeAt(index) & 0xff);
  }
  return btoa(binary);
}

export function splitUtf8Input(data: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of data) {
    const characterBytes = encoder.encode(character).byteLength;
    if (chunk && bytes + characterBytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += characterBytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function splitBinaryInput(data: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += maxBytes) {
    chunks.push(data.slice(offset, offset + maxBytes));
  }
  return chunks;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeDto(value: unknown): value is RuntimeDto {
  return Value.Check(RuntimeSchema, value);
}

export function shouldApplyTerminalStartResponse(
  current: RuntimeDto | undefined,
  response: RuntimeDto,
  socketStateChanged: boolean,
): boolean {
  if (socketStateChanged) return false;
  return !(
    current?.runtimeId === response.runtimeId &&
    current.state !== "starting" &&
    response.state === "starting"
  );
}

export function isTerminalServerFrame(
  value: unknown,
): value is TerminalServerFrame {
  if (
    !record(value) ||
    value.v !== TERMINAL_PROTOCOL_VERSION ||
    typeof value.type !== "string"
  )
    return false;
  if (value.type === "hello") {
    return (
      isRuntimeDto(value.runtime) &&
      typeof value.connectionId === "string" &&
      typeof value.inputOwner === "boolean" &&
      Number.isSafeInteger(value.earliestSeq) &&
      Number.isSafeInteger(value.latestSeq)
    );
  }
  if (value.type === "output") {
    return (
      Number.isSafeInteger(value.seq) &&
      typeof value.data === "string" &&
      typeof value.replay === "boolean"
    );
  }
  if (value.type === "replayReset") {
    return (
      Number.isSafeInteger(value.earliestSeq) &&
      Number.isSafeInteger(value.latestSeq)
    );
  }
  if (value.type === "runtime") return isRuntimeDto(value.runtime);
  if (value.type === "pong") return typeof value.nonce === "string";
  if (value.type === "error") {
    return typeof value.code === "string" && typeof value.message === "string";
  }
  return false;
}
