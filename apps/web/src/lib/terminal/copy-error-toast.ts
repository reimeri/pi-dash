import { toast } from "svelte-sonner";
import {
  errorMessage as clipboardErrorMessage,
  truncateMessage,
  writeClipboardText,
} from "../clipboard.js";

async function copyErrorDetails(message: string): Promise<void> {
  try {
    await writeClipboardText(message);
    toast.success("Error details copied");
  } catch (error) {
    toast.error("Unable to copy error details", {
      description: truncateMessage(
        clipboardErrorMessage(error, "The clipboard write failed."),
      ),
    });
  }
}

export function showTerminalCopyError(error: unknown): void {
  const detail = clipboardErrorMessage(error, "The clipboard write failed.");
  const fullMessage = `Unable to copy the terminal selection. ${detail}`;
  toast.error("Unable to copy the terminal selection", {
    description: truncateMessage(detail),
    duration: 10_000,
    action: {
      label: "Copy details",
      onClick: () => void copyErrorDetails(fullMessage),
    },
  });
}
