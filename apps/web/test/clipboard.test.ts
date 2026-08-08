import { afterEach, describe, expect, it, vi } from "vitest";
import {
  errorMessage,
  truncateMessage,
  writeClipboardText,
} from "../src/lib/clipboard.js";
import type { PiDashDesktopBridge } from "../src/lib/desktop-bridge.js";

afterEach(() => vi.unstubAllGlobals());

describe("clipboard", () => {
  it("uses the Electron native clipboard bridge when available", async () => {
    const writeClipboardTextMock = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      piDashDesktop: {
        writeClipboardText: writeClipboardTextMock,
      } as Partial<PiDashDesktopBridge>,
    });
    const browserWrite = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWrite } });

    await writeClipboardText("https://example.test/pull/42");

    expect(writeClipboardTextMock).toHaveBeenCalledWith(
      "https://example.test/pull/42",
    );
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it("uses the browser clipboard outside Electron", async () => {
    vi.stubGlobal("window", {});
    const browserWrite = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWrite } });

    await writeClipboardText("browser copy");

    expect(browserWrite).toHaveBeenCalledWith("browser copy");
  });

  it("preserves full errors while truncating only their display", () => {
    const full = `Clipboard failure: ${"x".repeat(240)}`;

    expect(errorMessage(new Error(full), "fallback")).toBe(full);
    expect(truncateMessage(full, 40)).toHaveLength(40);
    expect(truncateMessage(full, 40)).toMatch(/…$/);
    expect(truncateMessage("short", 40)).toBe("short");
  });
});
