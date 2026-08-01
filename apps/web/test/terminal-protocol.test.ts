import { describe, expect, it } from "vitest";
import {
  ALT_ENTER_SEQUENCE,
  SHIFT_ENTER_SEQUENCE,
  isTerminalServerFrame,
  splitBinaryInput,
  splitUtf8Input,
  translateModifiedEnter,
} from "../src/lib/terminal/protocol.js";

describe("terminal browser protocol", () => {
  it("translates only Shift+Enter and Alt+Enter keydown events", () => {
    const event = {
      type: "keydown",
      key: "Enter",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    };
    expect(translateModifiedEnter({ ...event, shiftKey: true })).toBe(
      SHIFT_ENTER_SEQUENCE,
    );
    expect(translateModifiedEnter({ ...event, altKey: true })).toBe(
      ALT_ENTER_SEQUENCE,
    );
    expect(translateModifiedEnter(event)).toBeNull();
    expect(
      translateModifiedEnter({ ...event, shiftKey: true, ctrlKey: true }),
    ).toBeNull();
  });

  it("splits large Unicode and binary input without changing content", () => {
    const text = "line one\n界λ".repeat(1_000);
    const chunks = splitUtf8Input(text, 257);
    expect(chunks.join("")).toBe(text);
    expect(
      chunks.every(
        (chunk) => new TextEncoder().encode(chunk).byteLength <= 257,
      ),
    ).toBe(true);
    const binary = Array.from({ length: 2_000 }, (_, index) =>
      String.fromCharCode(index % 256),
    ).join("");
    expect(splitBinaryInput(binary, 127).join("")).toBe(binary);
  });

  it("rejects malformed daemon frames", () => {
    expect(
      isTerminalServerFrame({
        v: 1,
        type: "output",
        seq: 1,
        data: "hello",
        replay: false,
      }),
    ).toBe(true);
    expect(
      isTerminalServerFrame({ v: 1, type: "output", seq: 1, data: "hello" }),
    ).toBe(false);
    expect(isTerminalServerFrame({ v: 2, type: "pong", nonce: "n" })).toBe(
      false,
    );
  });
});
