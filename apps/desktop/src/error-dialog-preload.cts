import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("piDashErrorDialog", {
  copy(): Promise<void> {
    return ipcRenderer.invoke("pi-dash:error-dialog-copy");
  },
  close(): void {
    ipcRenderer.send("pi-dash:error-dialog-close");
  },
});
