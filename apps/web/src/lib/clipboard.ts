import { desktopBridge } from "./desktop-bridge.js";

export async function writeClipboardText(text: string): Promise<void> {
  const desktop = desktopBridge();
  if (desktop) {
    await desktop.writeClipboardText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function truncateMessage(message: string, maximum = 180): string {
  if (message.length <= maximum) return message;
  return `${message.slice(0, maximum - 1).trimEnd()}…`;
}
