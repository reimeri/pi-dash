import {
  TERMINAL_PROTOCOL_VERSION,
  TerminalClientFrameSchema,
  type TerminalClientFrame,
} from "@pi-dash/contracts";
import { Value } from "@sinclair/typebox/value";

export type ClientFrameResult =
  | { ok: true; frame: TerminalClientFrame }
  | { ok: false; code: string; message: string; close?: number };

function canonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

export function parseTerminalClientFrame(text: string): ClientFrameResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Frame must be valid JSON",
    };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("v" in value) ||
    value.v !== TERMINAL_PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      code: "TERMINAL_PROTOCOL_MISMATCH",
      message: `Terminal protocol version ${TERMINAL_PROTOCOL_VERSION} is required`,
      close: 1002,
    };
  }
  if (!Value.Check(TerminalClientFrameSchema, value)) {
    return {
      ok: false,
      code:
        "type" in value && value.type === "resize"
          ? "INVALID_RESIZE"
          : "VALIDATION_ERROR",
      message: "Terminal frame has an invalid schema",
    };
  }
  if (value.type === "binaryInput" && !canonicalBase64(value.dataBase64)) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Binary input must use canonical Base64",
    };
  }
  return { ok: true, frame: value };
}
