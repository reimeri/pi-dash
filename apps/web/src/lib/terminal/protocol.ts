import type { TerminalServerFrame } from "@pi-dash/contracts";

export const SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";
export const ALT_ENTER_SEQUENCE = "\u001b[13;3u";

export function translateModifiedEnter(
  event: Pick<
    KeyboardEvent,
    "type" | "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"
  >,
): string | null {
  if (
    event.type !== "keydown" ||
    event.key !== "Enter" ||
    event.ctrlKey ||
    event.metaKey
  ) {
    return null;
  }
  if (event.shiftKey && !event.altKey) return SHIFT_ENTER_SEQUENCE;
  if (event.altKey && !event.shiftKey) return ALT_ENTER_SEQUENCE;
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

export function isTerminalServerFrame(
  value: unknown,
): value is TerminalServerFrame {
  if (!record(value) || value.v !== 1 || typeof value.type !== "string")
    return false;
  if (value.type === "hello") {
    return (
      record(value.runtime) &&
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
  if (value.type === "runtime") {
    return (
      ["stopped", "starting", "running", "stopping", "crashed"].includes(
        String(value.state),
      ) &&
      (value.exitCode === null || Number.isInteger(value.exitCode)) &&
      (value.signal === null || Number.isInteger(value.signal))
    );
  }
  if (value.type === "pong") return typeof value.nonce === "string";
  if (value.type === "error") {
    return typeof value.code === "string" && typeof value.message === "string";
  }
  return false;
}
