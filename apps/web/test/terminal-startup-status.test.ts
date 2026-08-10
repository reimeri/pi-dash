import { describe, expect, it } from "vitest";
import { terminalStartupStatus } from "../src/lib/terminal/startup-status.js";

const base = {
  kind: "pi" as const,
  enabled: true,
  interfaceState: "ready" as const,
  socketState: "connected" as const,
  runtimeState: "starting" as const,
};

describe("terminal startup status", () => {
  it("reports renderer preparation before process startup", () => {
    expect(
      terminalStartupStatus({ ...base, interfaceState: "loading" }),
    ).toEqual({
      label: "Opening Pi terminal",
      detail: "Loading terminal interface",
    });
    expect(terminalStartupStatus({ ...base, interfaceState: "fonts" })).toEqual(
      {
        label: "Opening Pi terminal",
        detail: "Loading terminal font",
      },
    );
  });

  it("distinguishes socket connection from process launch", () => {
    expect(
      terminalStartupStatus({ ...base, socketState: "connecting" }),
    ).toEqual({
      label: "Opening Pi terminal",
      detail: "Connecting to terminal",
    });
    expect(
      terminalStartupStatus({ ...base, socketState: "disconnected" }),
    ).toEqual({
      label: "Opening Pi terminal",
      detail: "Reconnecting to terminal",
    });
    expect(terminalStartupStatus(base)).toEqual({
      label: "Opening Pi terminal",
      detail: "Launching agent process",
    });
  });

  it("keeps reporting the socket while a running process is not attached", () => {
    expect(
      terminalStartupStatus({
        ...base,
        runtimeState: "running",
        socketState: "connecting",
      }),
    ).toEqual({
      label: "Opening Pi terminal",
      detail: "Connecting to terminal",
    });
    expect(
      terminalStartupStatus({
        ...base,
        runtimeState: "running",
        socketState: "disconnected",
      }),
    ).toEqual({
      label: "Opening Pi terminal",
      detail: "Reconnecting to terminal",
    });
  });

  it("uses shell-specific copy and hides after startup or failure", () => {
    expect(terminalStartupStatus({ ...base, kind: "shell" })).toEqual({
      label: "Opening shell terminal",
      detail: "Launching shell process",
    });
    expect(
      terminalStartupStatus({ ...base, runtimeState: "running" }),
    ).toBeUndefined();
    expect(
      terminalStartupStatus({ ...base, runtimeState: "stopping" }),
    ).toBeUndefined();
    expect(
      terminalStartupStatus({ ...base, runtimeState: "crashed" }),
    ).toBeUndefined();
    expect(
      terminalStartupStatus({ ...base, interfaceState: "error" }),
    ).toBeUndefined();
    expect(terminalStartupStatus({ ...base, enabled: false })).toBeUndefined();
  });
});
