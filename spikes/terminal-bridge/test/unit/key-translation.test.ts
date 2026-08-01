import { describe, expect, it } from "vitest";
import { ALT_ENTER_SEQUENCE, SHIFT_ENTER_SEQUENCE, translateModifiedEnter } from "../../src/key-translation.js";

const key = (overrides: Partial<KeyboardEvent> = {}) => ({
  type: "keydown",
  key: "Enter",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...overrides,
}) as KeyboardEvent;

describe("modified Enter translation", () => {
  it("uses CSI-u sequences Pi recognizes", () => {
    expect(translateModifiedEnter(key({ shiftKey: true }))).toBe(SHIFT_ENTER_SEQUENCE);
    expect(translateModifiedEnter(key({ altKey: true }))).toBe(ALT_ENTER_SEQUENCE);
  });

  it("does not alter Enter, keyup, combined, or unrelated keys", () => {
    expect(translateModifiedEnter(key())).toBeNull();
    expect(translateModifiedEnter(key({ type: "keyup", shiftKey: true }))).toBeNull();
    expect(translateModifiedEnter(key({ shiftKey: true, altKey: true }))).toBeNull();
    expect(translateModifiedEnter(key({ key: "x", shiftKey: true }))).toBeNull();
  });
});
