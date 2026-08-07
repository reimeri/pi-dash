import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  clipboard,
  dialog,
  screen,
  type BrowserWindowConstructorOptions,
} from "electron";

const ERROR_DIALOG_PRELOAD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "error-dialog-preload.cjs",
);

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildFatalErrorDialogHtml(
  title: string,
  content: string,
): string {
  const safeTitle = escapeHtml(title);
  const safeContent = escapeHtml(content);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
  />
  <title>${safeTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #141414;
      --panel: #1c1c1c;
      --border: #2e2e2e;
      --text: #f3f3f3;
      --muted: #a3a3a3;
      --button: #2a2a2a;
      --button-hover: #353535;
      --accent: #e8e8e8;
      --accent-text: #141414;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
    }
    body {
      display: flex;
      flex-direction: column;
      padding: 20px;
      gap: 14px;
    }
    h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      line-height: 1.3;
    }
    .detail {
      flex: 1 1 auto;
      min-height: 0;
      margin: 0;
      padding: 12px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      color: var(--muted);
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex: 0 0 auto;
    }
    button {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--button);
      color: var(--text);
      font: inherit;
      font-weight: 500;
      padding: 8px 14px;
      cursor: pointer;
    }
    button:hover { background: var(--button-hover); }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-text);
    }
    button.primary:hover { filter: brightness(0.95); }
    button.copied { opacity: 0.85; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <pre class="detail" id="detail">${safeContent}</pre>
  <div class="actions">
    <button type="button" id="copy">Copy error</button>
    <button type="button" class="primary" id="close">OK</button>
  </div>
  <script>
    const copy = document.getElementById("copy");
    const close = document.getElementById("close");
    copy.addEventListener("click", async () => {
      await window.piDashErrorDialog.copy();
      copy.textContent = "Copied";
      copy.classList.add("copied");
      copy.disabled = true;
      setTimeout(() => {
        copy.textContent = "Copy error";
        copy.classList.remove("copied");
        copy.disabled = false;
      }, 1500);
    });
    close.addEventListener("click", () => window.piDashErrorDialog.close());
    close.focus();
  </script>
</body>
</html>`;
}

function resolveParentWindow(
  parent?: BrowserWindow,
): BrowserWindow | undefined {
  if (parent && !parent.isDestroyed() && parent.isVisible()) return parent;
  const focused = BrowserWindow.getFocusedWindow();
  return focused && !focused.isDestroyed() && focused.isVisible()
    ? focused
    : undefined;
}

function dialogWindowOptions(
  parent?: BrowserWindow,
): BrowserWindowConstructorOptions {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(640, Math.max(420, Math.floor(workArea.width * 0.5)));
  const height = Math.min(
    520,
    Math.max(280, Math.floor(workArea.height * 0.6)),
  );
  return {
    width,
    height,
    minWidth: 400,
    minHeight: 260,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    parent,
    modal: Boolean(parent),
    webPreferences: {
      preload: ERROR_DIALOG_PRELOAD_PATH,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  };
}

async function showCustomFatalErrorDialog(
  title: string,
  content: string,
  parent?: BrowserWindow,
): Promise<void> {
  let directory: string | undefined;
  let errorWindow: BrowserWindow | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "pi-dash-error-"));
    chmodSync(directory, 0o700);
    const htmlPath = join(directory, "error.html");
    writeFileSync(htmlPath, buildFatalErrorDialogHtml(title, content), {
      encoding: "utf8",
      mode: 0o600,
    });

    const owner = resolveParentWindow(parent);
    errorWindow = new BrowserWindow(dialogWindowOptions(owner));
    errorWindow.setMenu(null);
    errorWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    errorWindow.webContents.on("will-navigate", (event) =>
      event.preventDefault(),
    );
    errorWindow.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );

    const copyHandler = (): void => {
      clipboard.writeText(content);
    };
    const closeHandler = (): void => {
      if (!errorWindow?.isDestroyed()) errorWindow?.close();
    };
    errorWindow.webContents.ipc.handle(
      "pi-dash:error-dialog-copy",
      copyHandler,
    );
    errorWindow.webContents.ipc.on("pi-dash:error-dialog-close", closeHandler);

    const closed = new Promise<void>((resolve) => {
      errorWindow?.once("closed", resolve);
    });
    await errorWindow.loadFile(htmlPath);
    if (!errorWindow.isDestroyed()) errorWindow.show();
    await closed;
  } finally {
    if (errorWindow && !errorWindow.isDestroyed()) errorWindow.destroy();
    if (directory) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // A temporary error report must not block application shutdown.
      }
    }
  }
}

/**
 * Show a fatal error dialog with the full message in a scrollable view
 * and a button to copy it. Falls back to Electron's native error box if the
 * custom window cannot be created or loaded, and never rejects.
 */
export async function showFatalErrorDialog(
  title: string,
  content: string,
  parent?: BrowserWindow,
): Promise<void> {
  try {
    await showCustomFatalErrorDialog(title, content, parent);
  } catch {
    try {
      dialog.showErrorBox(title, content);
    } catch {
      // Fatal reporting must not block application shutdown.
    }
  }
}
