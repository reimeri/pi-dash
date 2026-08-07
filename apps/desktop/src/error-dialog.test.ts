import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const state: {
    closeOnShow: boolean;
    destroyedWindows: number;
    eventHandlers: Map<string, () => void>;
    failConstruction: boolean;
    failLoad: boolean;
    focusedWindow: MockBrowserWindow | undefined;
    invokeHandlers: Map<string, () => void>;
    options: Record<string, unknown>[];
  } = {
    closeOnShow: true,
    destroyedWindows: 0,
    eventHandlers: new Map(),
    failConstruction: false,
    failLoad: false,
    focusedWindow: undefined,
    invokeHandlers: new Map(),
    options: [],
  };

  class MockBrowserWindow {
    static getFocusedWindow(): MockBrowserWindow | undefined {
      return state.focusedWindow;
    }

    readonly webContents = {
      ipc: {
        handle: vi.fn((channel: string, handler: () => void) => {
          state.invokeHandlers.set(channel, handler);
        }),
        on: vi.fn((channel: string, handler: () => void) => {
          state.eventHandlers.set(channel, handler);
        }),
      },
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    private destroyed = false;
    private visible = true;
    private readonly listeners = new Map<string, () => void>();

    constructor(options: Record<string, unknown>) {
      if (state.failConstruction) throw new Error("window unavailable");
      state.options.push(options);
    }

    close(): void {
      this.destroy();
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      state.destroyedWindows += 1;
      this.listeners.get("closed")?.();
    }

    hide(): void {
      this.visible = false;
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isVisible(): boolean {
      return this.visible;
    }

    async loadFile(): Promise<void> {
      if (state.failLoad) throw new Error("load failed");
    }

    once(event: string, listener: () => void): void {
      this.listeners.set(event, listener);
    }

    setMenu(): void {}

    show(): void {
      if (state.closeOnShow) this.destroy();
    }
  }

  return {
    BrowserWindow: MockBrowserWindow,
    clipboard: { writeText: vi.fn() },
    dialog: { showErrorBox: vi.fn() },
    screen: {
      getPrimaryDisplay: vi.fn(() => ({
        workAreaSize: { width: 1920, height: 1080 },
      })),
    },
    state,
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electron.BrowserWindow,
  clipboard: electron.clipboard,
  dialog: electron.dialog,
  screen: electron.screen,
}));

import {
  buildFatalErrorDialogHtml,
  escapeHtml,
  showFatalErrorDialog,
} from "./error-dialog.js";

beforeEach(() => {
  electron.state.closeOnShow = true;
  electron.state.destroyedWindows = 0;
  electron.state.eventHandlers.clear();
  electron.state.failConstruction = false;
  electron.state.failLoad = false;
  electron.state.focusedWindow = undefined;
  electron.state.invokeHandlers.clear();
  electron.state.options.length = 0;
  vi.clearAllMocks();
});

describe("fatal error dialog markup", () => {
  it("escapes HTML in the title and body", () => {
    const html = buildFatalErrorDialogHtml(
      `Failed <script>alert(1)</script>`,
      `path & "quotes"\n<details>`,
    );
    expect(html).toContain("Failed &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("path &amp; &quot;quotes&quot;\n&lt;details&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("preserves the full error body for scrolling and copy", () => {
    const content = Array.from(
      { length: 80 },
      (_, index) => `line ${index + 1}: ${"x".repeat(120)}`,
    ).join("\n");
    const html = buildFatalErrorDialogHtml("Pi Dash failed to start", content);
    expect(html).toContain(`id="detail">${escapeHtml(content)}</pre>`);
    expect(html).toContain("Copy error");
    expect(html).toContain("overflow: auto");
    expect(html).not.toContain("…truncated");
  });
});

describe("showFatalErrorDialog", () => {
  it("does not attach the dialog to a hidden parent", async () => {
    const hiddenParent = new electron.BrowserWindow({});
    hiddenParent.hide();
    electron.state.options.length = 0;

    await showFatalErrorDialog(
      "Pi Dash failed to load",
      "connection refused",
      hiddenParent as never,
    );

    expect(electron.state.options).toHaveLength(1);
    expect(electron.state.options[0]).toMatchObject({
      modal: false,
      parent: undefined,
    });
  });

  it("falls back and destroys the custom window when loading fails", async () => {
    electron.state.failLoad = true;

    await expect(
      showFatalErrorDialog("Pi Dash failed", "details"),
    ).resolves.toBeUndefined();

    expect(electron.state.destroyedWindows).toBe(1);
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      "Pi Dash failed",
      "details",
    );
  });

  it("wires copy and close actions through window-scoped IPC", async () => {
    electron.state.closeOnShow = false;
    const shown = showFatalErrorDialog("Pi Dash failed", "full details");
    await vi.waitFor(() => {
      expect(
        electron.state.eventHandlers.has("pi-dash:error-dialog-close"),
      ).toBe(true);
    });

    electron.state.invokeHandlers.get("pi-dash:error-dialog-copy")?.();
    expect(electron.clipboard.writeText).toHaveBeenCalledWith("full details");

    electron.state.eventHandlers.get("pi-dash:error-dialog-close")?.();
    await expect(shown).resolves.toBeUndefined();
  });

  it("falls back to the native error box without rejecting", async () => {
    electron.state.failConstruction = true;

    await expect(
      showFatalErrorDialog("Pi Dash failed", "details"),
    ).resolves.toBeUndefined();
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      "Pi Dash failed",
      "details",
    );
  });
});
