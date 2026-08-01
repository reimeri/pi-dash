import type { TerminalRuntimeState } from "@pi-dash/contracts";

export type TerminalSocketState = "connecting" | "connected" | "disconnected";

export interface TerminalControls {
  runtimeState: TerminalRuntimeState;
  socketState: TerminalSocketState;
  inputOwner: boolean;
  inputOwnerKnown: boolean;
  busy: boolean;
  focus: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}

export type TerminalControlsChange = (
  controls: TerminalControls | undefined,
) => void;
