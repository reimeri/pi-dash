import type { WorkspaceDto } from "@pi-dash/contracts";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceStore,
  sortWorkspaces,
} from "../src/lib/workspaces/store.js";

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

describe("workspace store", () => {
  it("orders names deterministically for immediate sidebar updates", () => {
    const ordered = sortWorkspaces([
      workspace("00000000-0000-4000-8000-000000000003", "Project 10"),
      workspace("00000000-0000-4000-8000-000000000001", "alpha"),
      workspace("00000000-0000-4000-8000-000000000002", "Project 2"),
    ]);
    expect(ordered.map((item) => item.name)).toEqual([
      "alpha",
      "Project 2",
      "Project 10",
    ]);
  });

  it("does not let a stale failed load overwrite a newer mutation", async () => {
    let rejectLoad!: (error: Error) => void;
    const store = createWorkspaceStore({
      workspaces: () =>
        new Promise((_resolve, reject) => {
          rejectLoad = reject;
        }),
    });
    const loading = store.load();
    store.upsert(workspace("00000000-0000-4000-8000-000000000001", "Created"));
    rejectLoad(new Error("stale load failed"));
    await loading;

    expect(get(store)).toMatchObject({
      status: "ready",
      workspaces: [{ name: "Created" }],
    });
  });

  it("reloads an authoritative list after an upsert races with loading", async () => {
    const existing = workspace(
      "00000000-0000-4000-8000-000000000001",
      "Existing",
    );
    const updated = workspace(
      "00000000-0000-4000-8000-000000000002",
      "Updated",
    );
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
    });

    const firstLoad = store.load();
    store.upsert(updated);
    firstResolve({ workspaces: [existing] });
    await firstLoad;
    await vi.waitFor(() => expect(calls).toBe(2));
    secondResolve({ workspaces: [existing, updated] });
    await vi.waitFor(() =>
      expect(get(store).workspaces.map((item) => item.name)).toEqual([
        "Existing",
        "Updated",
      ]),
    );
  });

  it("upserts health changes and removes workspace records", () => {
    const store = createWorkspaceStore();
    const id = "00000000-0000-4000-8000-000000000001";
    store.upsert(workspace(id, "Project"));
    store.upsert(workspace(id, "Project", "missing"));
    expect(get(store)).toMatchObject({
      status: "ready",
      workspaces: [{ repository: { health: "missing" } }],
    });
    store.remove(id);
    expect(get(store).workspaces).toEqual([]);
  });
});
