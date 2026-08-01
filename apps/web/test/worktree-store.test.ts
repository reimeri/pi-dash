import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { createWorktreeStore } from "../src/lib/worktrees/store.js";

describe("worktree store", () => {
  it("tracks concurrent workspace loads and failures independently", async () => {
    let resolveFirst!: (value: { worktrees: [] }) => void;
    let rejectSecond!: (error: Error) => void;
    const firstResponse = new Promise<{ worktrees: [] }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise<{ worktrees: [] }>(
      (_resolve, reject) => {
        rejectSecond = reject;
      },
    );
    const store = createWorktreeStore({
      worktrees: (workspaceId) =>
        workspaceId === "first" ? firstResponse : secondResponse,
      reconcileWorktrees: async () => ({ worktrees: [] }),
    });

    const firstLoad = store.load("first");
    const secondLoad = store.load("second");
    expect(get(store).loadingByWorkspace).toEqual({
      first: true,
      second: true,
    });

    resolveFirst({ worktrees: [] });
    await firstLoad;
    expect(get(store).loadingByWorkspace).toEqual({
      first: false,
      second: true,
    });

    rejectSecond(new Error("second workspace failed"));
    await secondLoad;
    expect(get(store)).toMatchObject({
      loadingByWorkspace: { first: false, second: false },
      errorsByWorkspace: { second: "second workspace failed" },
    });
  });
});
