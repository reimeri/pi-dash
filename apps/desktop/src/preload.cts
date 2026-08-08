import { contextBridge, ipcRenderer } from "electron";

type RecoveryStatus = "retrying" | "recovered" | "restarting";

contextBridge.exposeInMainWorld("piDashDesktop", {
  writeClipboardText(text: string): Promise<void> {
    return ipcRenderer.invoke("pi-dash:clipboard-write-text", text);
  },
  reauthenticate(): Promise<void> {
    return ipcRenderer.invoke("pi-dash:reauthenticate");
  },
  onRecoveryStatus(callback: (status: RecoveryStatus) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      status: RecoveryStatus,
    ) => callback(status);
    ipcRenderer.on("pi-dash:recovery-status", listener);
    return () =>
      ipcRenderer.removeListener("pi-dash:recovery-status", listener);
  },
});
