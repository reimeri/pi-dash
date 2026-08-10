import { describe, expect, it } from "vitest";
import {
  ALT_ENTER_SEQUENCE,
  SHIFT_ENTER_SEQUENCE,
  isTerminalServerFrame,
  shouldApplyTerminalStartResponse,
  splitBinaryInput,
  splitUtf8Input,
  translateTerminalKey,
} from "../src/lib/terminal/protocol.js";

describe("terminal browser protocol", () => {
  it("translates modified Enter and distinguishable Ctrl+Shift keys", () => {
    const event = {
      type: "keydown",
      key: "Enter",
      code: "Enter",
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    };
    expect(translateTerminalKey({ ...event, shiftKey: true })).toBe(
      SHIFT_ENTER_SEQUENCE,
    );
    expect(translateTerminalKey({ ...event, altKey: true })).toBe(
      ALT_ENTER_SEQUENCE,
    );
    expect(
      translateTerminalKey({
        ...event,
        key: "P",
        code: "KeyP",
        shiftKey: true,
        ctrlKey: true,
      }),
    ).toBe("\u001b[112;6u");
    expect(
      translateTerminalKey({
        ...event,
        key: "O",
        code: "KeyO",
        shiftKey: true,
        ctrlKey: true,
      }),
    ).toBe("\u001b[111;6u");
    expect(
      translateTerminalKey({
        ...event,
        key: "З",
        code: "KeyP",
        shiftKey: true,
        ctrlKey: true,
      }),
    ).toBe("\u001b[1079::112;6u");
    expect(translateTerminalKey(event)).toBeNull();
    expect(
      translateTerminalKey({ ...event, shiftKey: true, ctrlKey: true }),
    ).toBeNull();
  });

  it("leaves browser copy and paste combinations to their dedicated handlers", () => {
    const event = {
      type: "keydown",
      code: "KeyC",
      shiftKey: true,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
    };
    expect(translateTerminalKey({ ...event, key: "C" })).toBeNull();
    expect(
      translateTerminalKey({ ...event, key: "V", code: "KeyV" }),
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

  it("does not let a delayed starting response replace a newer socket state", () => {
    const starting = {
      worktreeId: "11111111-1111-4111-8111-111111111111",
      runtimeId: "22222222-2222-4222-8222-222222222222",
      state: "starting",
      startedAt: null,
      exitedAt: null,
      exitCode: null,
      signal: null,
      launchError: null,
      attachedClients: 0,
    } as const;
    const running = {
      ...starting,
      state: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    } as const;

    expect(shouldApplyTerminalStartResponse(running, starting, false)).toBe(
      false,
    );
    expect(shouldApplyTerminalStartResponse(starting, running, false)).toBe(
      true,
    );
    expect(
      shouldApplyTerminalStartResponse(
        { ...running, runtimeId: "33333333-3333-4333-8333-333333333333" },
        starting,
        true,
      ),
    ).toBe(false);
  });

  it("rejects malformed daemon frames", () => {
    expect(
      isTerminalServerFrame({
        v: 2,
        type: "output",
        seq: 1,
        data: "hello",
        replay: false,
      }),
    ).toBe(true);
    expect(
      isTerminalServerFrame({ v: 2, type: "output", seq: 1, data: "hello" }),
    ).toBe(false);
    expect(isTerminalServerFrame({ v: 1, type: "pong", nonce: "n" })).toBe(
      false,
    );
    const validRuntimeFrame = {
      v: 2,
      type: "runtime",
      runtime: {
        worktreeId: "11111111-1111-4111-8111-111111111111",
        runtimeId: "22222222-2222-4222-8222-222222222222",
        state: "crashed",
        startedAt: null,
        exitedAt: "2026-01-01T00:00:00.000Z",
        exitCode: null,
        signal: null,
        launchError: { code: "PTY_START_FAILED", message: "Launch failed" },
        attachedClients: 1,
      },
    } as const;
    expect(isTerminalServerFrame(validRuntimeFrame)).toBe(true);
    expect(
      isTerminalServerFrame({
        ...validRuntimeFrame,
        runtime: { ...validRuntimeFrame.runtime, worktreeId: "invalid" },
      }),
    ).toBe(false);
    expect(
      isTerminalServerFrame({
        ...validRuntimeFrame,
        runtime: { ...validRuntimeFrame.runtime, unexpected: true },
      }),
    ).toBe(false);
  });
});
