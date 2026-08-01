export interface BrowserDiagnostics {
  mounts: number;
  activeTerminals: number;
  activeSockets: number;
  activeObservers: number;
  activeAddons: number;
  reconnects: number;
  malformedServerFrames: number;
  translatedShiftEnter: number;
  translatedAltEnter: number;
}

declare global {
  interface Window {
    __terminalSpikeDiagnostics?: BrowserDiagnostics;
  }
}

export function diagnostics(): BrowserDiagnostics {
  window.__terminalSpikeDiagnostics ??= {
    mounts: 0,
    activeTerminals: 0,
    activeSockets: 0,
    activeObservers: 0,
    activeAddons: 0,
    reconnects: 0,
    malformedServerFrames: 0,
    translatedShiftEnter: 0,
    translatedAltEnter: 0,
  };
  return window.__terminalSpikeDiagnostics;
}
