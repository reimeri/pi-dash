import type { TerminalRuntimeState } from "@pi-dash/contracts";
import type { TerminalSocketState } from "./controls.js";

export type TerminalInterfaceState = "loading" | "fonts" | "ready" | "error";

export interface TerminalStartupStatus {
  label: string;
  detail: string;
}

export function terminalStartupStatus(input: {
  kind: "pi" | "shell";
  enabled: boolean;
  interfaceState: TerminalInterfaceState;
  socketState: TerminalSocketState;
  runtimeState?: TerminalRuntimeState;
}): TerminalStartupStatus | undefined {
  const label =
    input.kind === "pi" ? "Opening Pi terminal" : "Opening shell terminal";

  if (
    !input.enabled ||
    input.interfaceState === "error" ||
    input.runtimeState === "stopped" ||
    input.runtimeState === "stopping" ||
    input.runtimeState === "crashed"
  ) {
    return undefined;
  }
  if (input.interfaceState === "loading") {
    return { label, detail: "Loading terminal interface" };
  }
  if (input.interfaceState === "fonts") {
    return { label, detail: "Loading terminal font" };
  }
  if (input.socketState === "connecting") {
    return { label, detail: "Connecting to terminal" };
  }
  if (input.socketState === "disconnected") {
    return { label, detail: "Reconnecting to terminal" };
  }
  if (input.runtimeState === "running") return undefined;
  return {
    label,
    detail:
      input.kind === "pi"
        ? "Launching agent process"
        : "Launching shell process",
  };
}
