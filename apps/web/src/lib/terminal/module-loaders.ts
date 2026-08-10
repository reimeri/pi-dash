type ModuleLoader<T> = () => Promise<T>;

export function createRetryableModuleLoader<T>(
  importModule: ModuleLoader<T>,
): ModuleLoader<T> {
  let cached: Promise<T> | undefined;
  return () => {
    cached ??= importModule().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

export const loadPiTerminalWorkspace = createRetryableModuleLoader(
  () => import("./TerminalWorkspace.svelte"),
);
export const loadShellTerminalWorkspace = createRetryableModuleLoader(
  () => import("./ShellTerminalWorkspace.svelte"),
);
export const loadXtermModule = createRetryableModuleLoader(
  () => import("@xterm/xterm"),
);
export const loadFitAddon = createRetryableModuleLoader(
  () => import("@xterm/addon-fit"),
);
export const loadUnicode11Addon = createRetryableModuleLoader(
  () => import("@xterm/addon-unicode11"),
);

const terminalModuleLoaders: readonly ModuleLoader<unknown>[] = [
  loadPiTerminalWorkspace,
  loadShellTerminalWorkspace,
  loadXtermModule,
  loadFitAddon,
  loadUnicode11Addon,
];

export async function preloadTerminalModules(
  loaders: readonly ModuleLoader<unknown>[] = terminalModuleLoaders,
): Promise<void> {
  await Promise.allSettled(loaders.map((load) => load()));
}

export interface TerminalPreloadHost {
  requestIdleCallback?: Window["requestIdleCallback"];
  cancelIdleCallback?: Window["cancelIdleCallback"];
  setTimeout: Window["setTimeout"];
  clearTimeout: Window["clearTimeout"];
}

export function scheduleTerminalModulePreload(
  preload: () => Promise<void> = preloadTerminalModules,
  host: TerminalPreloadHost = window,
): () => void {
  let cancelled = false;
  const run = () => {
    if (!cancelled) void preload().catch(() => undefined);
  };

  if (host.requestIdleCallback && host.cancelIdleCallback) {
    const handle = host.requestIdleCallback(run, { timeout: 2_000 });
    return () => {
      cancelled = true;
      host.cancelIdleCallback?.(handle);
    };
  }

  const handle = host.setTimeout(run, 1_000);
  return () => {
    cancelled = true;
    host.clearTimeout(handle);
  };
}
