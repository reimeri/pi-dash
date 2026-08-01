import { describe, expect, it } from "vitest";
import { createTerminalEnvironment } from "../src/terminal/environment.js";
import { OutputRing } from "../src/terminal/output-ring.js";
import { parseTerminalClientFrame } from "../src/terminal/terminal-protocol.js";

describe("terminal core contracts", () => {
  it("bounds output by bytes and chunks while retaining monotonic sequence", () => {
    const ring = new OutputRing(8, 2);
    expect(ring.push("one").seq).toBe(1);
    ring.push("two");
    ring.push("three");
    expect(ring.length).toBeLessThanOrEqual(2);
    expect(ring.bytes).toBeLessThanOrEqual(8);
    expect(ring.earliestSeq).toBe(2);
    expect(ring.canReplayAfter(0)).toBe(false);
    expect(ring.replayAfter(2).map((entry) => entry.data)).toEqual(["three"]);
    expect(ring.push("0123456789").seq).toBe(4);
    expect(ring.length).toBe(0);
    expect(ring.latestSeq).toBe(4);
  });

  it("validates versioned frames, dimensions, and canonical binary data", () => {
    expect(
      parseTerminalClientFrame('{"v":1,"type":"attach","afterSeq":0}'),
    ).toMatchObject({ ok: true });
    expect(
      parseTerminalClientFrame('{"v":1,"type":"resize","cols":0,"rows":20}'),
    ).toMatchObject({ ok: false, code: "INVALID_RESIZE" });
    expect(
      parseTerminalClientFrame('{"v":0,"type":"attach","afterSeq":0}'),
    ).toMatchObject({
      ok: false,
      code: "TERMINAL_PROTOCOL_MISMATCH",
      close: 1002,
    });
    expect(
      parseTerminalClientFrame(
        '{"v":1,"type":"binaryInput","dataBase64":"not base64"}',
      ),
    ).toMatchObject({ ok: false });
  });

  it("removes internal dashboard variables and reintroduces only runtime status values", () => {
    const env = createTerminalEnvironment({
      inherited: {
        HOME: "/home/test",
        PATH: "/bin",
        OPENAI_API_KEY: "provider",
        PI_CONFIG_DIR: "/home/test/.pi",
        PI_DASH_BOOTSTRAP_TOKEN: "secret",
        PI_DASH_STATUS_TOKEN: "old",
      },
      runtimeDirectory: "/run/user/1000/pi-dash",
      runtimeId: "runtime-id",
      statusToken: "new-token",
    });
    expect(env).toMatchObject({
      HOME: "/home/test",
      PATH: "/bin",
      OPENAI_API_KEY: "provider",
      PI_CONFIG_DIR: "/home/test/.pi",
      PI_DASH_RUNTIME_ID: "runtime-id",
      PI_DASH_STATUS_TOKEN: "new-token",
    });
    expect(env.PI_DASH_BOOTSTRAP_TOKEN).toBeUndefined();
    expect(
      Object.keys(env)
        .filter((key) => key.startsWith("PI_DASH_"))
        .sort(),
    ).toEqual([
      "PI_DASH_RUNTIME_ID",
      "PI_DASH_STATUS_SOCKET",
      "PI_DASH_STATUS_TOKEN",
      "PI_DASH_WORKTREE_ID",
    ]);
  });
});
