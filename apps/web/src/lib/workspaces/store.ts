import type { WorkspaceDto } from "@pi-dash/contracts";
import { writable } from "svelte/store";
import { api } from "../../api.js";

export interface WorkspaceState {
  status: "idle" | "loading" | "ready" | "error";
  workspaces: WorkspaceDto[];
  message?: string;
}

export function sortWorkspaces(workspaces: WorkspaceDto[]): WorkspaceDto[] {
  return [...workspaces].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export function createWorkspaceStore(
  client: Pick<typeof api, "workspaces"> = api,
) {
  const { subscribe, set, update } = writable<WorkspaceState>({
    status: "idle",
    workspaces: [],
  });
  let revision = 0;
  let loadGeneration = 0;

  return {
    subscribe,
    async load() {
      const generation = ++loadGeneration;
      const startingRevision = revision;
      update((state) => ({ ...state, status: "loading", message: undefined }));
      try {
        const response = await client.workspaces();
        if (generation !== loadGeneration) return;
        if (revision !== startingRevision) {
          update((state) => ({ ...state, status: "ready" }));
          void this.load();
          return;
        }
        set({
          status: "ready",
          workspaces: sortWorkspaces(response.workspaces),
        });
      } catch (error) {
        if (generation !== loadGeneration) return;
        if (revision !== startingRevision) {
          update((state) => ({ ...state, status: "ready" }));
          return;
        }
        update((state) => ({
          ...state,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to load workspaces",
        }));
      }
    },
    upsert(workspace: WorkspaceDto) {
      revision += 1;
      update((state) => ({
        status: "ready",
        workspaces: sortWorkspaces([
          ...state.workspaces.filter((item) => item.id !== workspace.id),
          workspace,
        ]),
      }));
    },
    remove(id: string) {
      revision += 1;
      update((state) => ({
        ...state,
        workspaces: state.workspaces.filter((item) => item.id !== id),
      }));
    },
  };
}

export const workspaceStore = createWorkspaceStore();
