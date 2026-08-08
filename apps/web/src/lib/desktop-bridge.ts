export type DesktopRecoveryStatus = "retrying" | "recovered" | "restarting";

export interface PiDashDesktopBridge {
  writeClipboardText(text: string): Promise<void>;
  reauthenticate(): Promise<void>;
  onRecoveryStatus(
    callback: (status: DesktopRecoveryStatus) => void,
  ): () => void;
}

declare global {
  interface Window {
    piDashDesktop?: PiDashDesktopBridge;
  }
}

export function desktopBridge(): PiDashDesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.piDashDesktop;
}
