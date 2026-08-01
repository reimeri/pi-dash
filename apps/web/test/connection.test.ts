import { describe, expect, it } from "vitest";
import { initialStartupState, reduceStartupState } from "../src/connection.js";

describe("startup state reducer", () => {
  it("represents every foundation connection state", () => {
    expect(
      reduceStartupState(initialStartupState, { type: "READY" }).status,
    ).toBe("ready");
    expect(
      reduceStartupState(initialStartupState, { type: "UNAUTHORIZED" }).status,
    ).toBe("unauthorized");
    expect(
      reduceStartupState(initialStartupState, { type: "MIGRATION_FAILED" })
        .status,
    ).toBe("migration-failed");
    expect(
      reduceStartupState(initialStartupState, { type: "DISCONNECTED" }).status,
    ).toBe("disconnected");
    expect(
      reduceStartupState(
        { status: "ready", message: "Connected" },
        { type: "CONNECT" },
      ),
    ).toEqual(initialStartupState);
  });
});
