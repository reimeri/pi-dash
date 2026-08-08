import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeClipboardText: vi.fn<(text: string) => Promise<void>>(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("svelte-sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../src/lib/clipboard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clipboard.js")>()),
  writeClipboardText: mocks.writeClipboardText,
}));

import { showTerminalCopyError } from "../src/lib/terminal/copy-error-toast.js";

describe("terminal copy error toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeClipboardText.mockResolvedValue();
  });

  it("truncates displayed detail and copies the complete message", async () => {
    const detail = `Native clipboard failed: ${"x".repeat(240)}`;
    showTerminalCopyError(new Error(detail));

    expect(mocks.toastError).toHaveBeenCalledOnce();
    const [title, options] = mocks.toastError.mock.calls[0] as [
      string,
      {
        description: string;
        action: { label: string; onClick: () => void };
      },
    ];
    expect(title).toBe("Unable to copy the terminal selection");
    expect(options.description).toHaveLength(180);
    expect(options.description).toMatch(/…$/);
    expect(options.action.label).toBe("Copy details");

    options.action.onClick();
    await vi.waitFor(() =>
      expect(mocks.writeClipboardText).toHaveBeenCalledWith(
        `Unable to copy the terminal selection. ${detail}`,
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Error details copied");
  });
});
