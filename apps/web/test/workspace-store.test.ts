import type { WorkspaceDto } from "@pi-dash/contracts";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceStore } from "../src/lib/workspaces/store.js";

function workspace(
  id: string,
  name: string,
  health: WorkspaceDto["repository"]["health"] = "healthy",
): WorkspaceDto {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    repositoryPath: `/tmp/${id}`,
    repository: {
      health,
      syncStatus: "unknown",
      currentBranch: "main",
      headCommit: "a".repeat(40),
      checkedAt: "2026-01-01T00:00:00.000Z",
    },
    worktreeCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const first = workspace("00000000-0000-4000-8000-000000000001", "First");
const second = workspace("00000000-0000-4000-8000-000000000002", "Second");
const third = workspace("00000000-0000-4000-8000-000000000003", "Third");

describe("workspace store", () => {
  it("forwards cancellation to workspace loads", async () => {
    const workspaces = vi.fn(async () => ({ workspaces: [] }));
    const store = createWorkspaceStore({
      workspaces,
      reorderWorkspaces: vi.fn(),
    });
    const signal = AbortSignal.abort();
    await store.load(signal);
    expect(workspaces).toHaveBeenCalledWith(signal);
  });

  it("reports current load failures to connection recovery", async () => {
    const store = createWorkspaceStore({
      workspaces: async () => {
        throw new Error("offline");
      },
      reorderWorkspaces: vi.fn(),
    });
    await expect(store.load()).resolves.toBe(false);
    expect(get(store)).toMatchObject({ status: "error", message: "offline" });
  });

  it("preserves authoritative server order", async () => {
    const store = createWorkspaceStore({
      workspaces: async () => ({ workspaces: [third, first, second] }),
      reorderWorkspaces: vi.fn(),
    });
    await store.load();
    expect(get(store).workspaces.map((item) => item.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);
  });

  it("does not let a stale failed load overwrite a newer mutation", async () => {
    let rejectLoad!: (error: Error) => void;
    const store = createWorkspaceStore({
      workspaces: () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        }),
      reorderWorkspaces: vi.fn(),
    });
    const loading = store.load();
    store.upsert(first);
    rejectLoad(new Error("stale load failed"));
    await loading;

    expect(get(store)).toMatchObject({
      status: "ready",
      workspaces: [{ name: "First" }],
    });
  });

  it("reloads an authoritative list after an upsert races with loading", async () => {
    let firstResolve!: (value: { workspaces: WorkspaceDto[] }) => void;
    let secondResolve!: (value: { workspaces: WorkspaceDto[] }) => void;
    let calls = 0;
    const store = createWorkspaceStore({
      workspaces: () => {
        calls += 1;
        return new Promise((resolve) => {
          if (calls === 1) firstResolve = resolve;
          else secondResolve = resolve;
        });
      },
      reorderWorkspaces: vi.fn(),
    });

    const initialLoad = store.load();
    store.upsert(second);
    firstResolve({ workspaces: [first] });
    await initialLoad;
    await vi.waitFor(() => expect(calls).toBe(2));
    secondResolve({ workspaces: [second, first] });
    await vi.waitFor(() =>
      expect(get(store).workspaces.map((item) => item.id)).toEqual([
        second.id,
        first.id,
      ]),
    );
  });

  it("preserves an existing position and inserts new workspaces at the top", async () => {
    const store = createWorkspaceStore({
      workspaces: async () => ({ workspaces: [second, first] }),
      reorderWorkspaces: vi.fn(),
    });
    await store.load();
    store.upsert({ ...first, name: "Renamed" });
    store.upsert(third);
    expect(get(store).workspaces.map((item) => item.name)).toEqual([
      "Third",
      "Second",
      "Renamed",
    ]);
    store.remove(second.id);
    expect(get(store).workspaces.map((item) => item.id)).toEqual([
      third.id,
      first.id,
    ]);
  });

  it("optimistically reorders and applies the authoritative response", async () => {
    let resolveReorder!: (value: { workspaces: WorkspaceDto[] }) => void;
    const reorderWorkspaces = vi.fn(
      () =>
        new Promise<{ workspaces: WorkspaceDto[] }>((resolve) => {
          resolveReorder = resolve;
        }),
    );
    const store = createWorkspaceStore({
      workspaces: async () => ({ workspaces: [first, second, third] }),
      reorderWorkspaces,
    });
    await store.load();

    const reordering = store.reorder([third.id, first.id, second.id]);
    expect(get(store)).toMatchObject({ reordering: true });
    expect(get(store).workspaces.map((item) => item.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);
    expect(reorderWorkspaces).toHaveBeenCalledWith({
      expectedWorkspaceIds: [first.id, second.id, third.id],
      workspaceIds: [third.id, first.id, second.id],
    });

    resolveReorder({ workspaces: [third, first, second] });
    await reordering;
    expect(get(store)).toMatchObject({ reordering: false, status: "ready" });
  });

  it("keeps the reorder lock while a load is requested", async () => {
    let resolveReorder!: (value: { workspaces: WorkspaceDto[] }) => void;
    let loads = 0;
    const reorderWorkspaces = vi.fn(
      () =>
        new Promise<{ workspaces: WorkspaceDto[] }>((resolve) => {
          resolveReorder = resolve;
        }),
    );
    const store = createWorkspaceStore({
      workspaces: async () => {
        loads += 1;
        return {
          workspaces:
            loads === 1 ? [first, second, third] : [third, first, second],
        };
      },
      reorderWorkspaces,
    });
    await store.load();

    const firstReorder = store.reorder([third.id, first.id, second.id]);
    await store.load();
    await store.reorder([second.id, third.id, first.id]);
    expect(loads).toBe(1);
    expect(reorderWorkspaces).toHaveBeenCalledTimes(1);
    expect(get(store).reordering).toBe(true);

    resolveReorder({ workspaces: [third, first, second] });
    await firstReorder;
    expect(loads).toBe(2);
    expect(get(store)).toMatchObject({ reordering: false });
  });

  it("rolls back if both reorder and reconciliation fail", async () => {
    let loads = 0;
    const store = createWorkspaceStore({
      workspaces: async () => {
        loads += 1;
        if (loads > 1) throw new Error("Reload failed");
        return { workspaces: [first, second, third] };
      },
      reorderWorkspaces: async () => {
        throw new Error("Reorder failed");
      },
    });
    await store.load();

    await expect(
      store.reorder([third.id, first.id, second.id]),
    ).rejects.toThrow("Reorder failed");
    expect(get(store).workspaces.map((workspace) => workspace.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(get(store)).toMatchObject({
      reordering: false,
      status: "error",
      message: "Reload failed",
    });
  });

  it("applies matching order events and reloads after a conflict", async () => {
    let loads = 0;
    const store = createWorkspaceStore({
      workspaces: async () => {
        loads += 1;
        return {
          workspaces:
            loads === 1 ? [first, second, third] : [second, third, first],
        };
      },
      reorderWorkspaces: async () => {
        throw new Error("Workspace order changed");
      },
    });
    await store.load();
    expect(store.applyOrder([third.id, first.id, second.id])).toBe(true);
    expect(get(store).workspaces.map((item) => item.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);

    await expect(
      store.reorder([first.id, third.id, second.id]),
    ).rejects.toThrow("Workspace order changed");
    expect(get(store).workspaces.map((item) => item.id)).toEqual([
      second.id,
      third.id,
      first.id,
    ]);
    expect(store.applyOrder([first.id])).toBe(false);
    await vi.waitFor(() => expect(loads).toBe(3));
  });
});
