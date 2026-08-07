import type { WorkspaceDto } from "@pi-dash/contracts";
import { writable } from "svelte/store";
import { api } from "../../api.js";

export interface WorkspaceState {
  status: "idle" | "loading" | "ready" | "error";
  workspaces: WorkspaceDto[];
  reordering: boolean;
  message?: string;
}

export function createWorkspaceStore(
  client: Pick<typeof api, "workspaces" | "reorderWorkspaces"> = api,
) {
  const initialState: WorkspaceState = {
    status: "idle",
    workspaces: [],
    reordering: false,
  };
  const { subscribe, set, update } = writable<WorkspaceState>(initialState);
  let current = initialState;
  subscribe((state) => (current = state));
  let revision = 0;
  let loadGeneration = 0;
  let nextReorderOperation = 0;
  let activeReorderOperation: number | undefined;
  let reloadAfterReorder = false;

  const replaceWorkspaces = (workspaces: WorkspaceDto[]): void => {
    set({ status: "ready", workspaces, reordering: false });
  };

  const store = {
    subscribe,
    async load(signal?: AbortSignal): Promise<boolean> {
      if (activeReorderOperation !== undefined) {
        reloadAfterReorder = true;
        return true;
      }
      const generation = ++loadGeneration;
      const startingRevision = revision;
      update((state) => ({ ...state, status: "loading", message: undefined }));
      try {
        const response = await client.workspaces(signal);
        if (generation !== loadGeneration) return true;
        if (activeReorderOperation !== undefined) {
          reloadAfterReorder = true;
          return true;
        }
        if (revision !== startingRevision) {
          update((state) => ({ ...state, status: "ready" }));
          void store.load();
          return true;
        }
        replaceWorkspaces(response.workspaces);
        return true;
      } catch (error) {
        if (generation !== loadGeneration) return true;
        if (activeReorderOperation !== undefined) {
          reloadAfterReorder = true;
          return true;
        }
        if (revision !== startingRevision) {
          update((state) => ({ ...state, status: "ready" }));
          return true;
        }
        update((state) => ({
          ...state,
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to load workspaces",
        }));
        return false;
      }
    },
    upsert(workspace: WorkspaceDto) {
      revision += 1;
      update((state) => {
        const existingIndex = state.workspaces.findIndex(
          (item) => item.id === workspace.id,
        );
        if (existingIndex === -1) {
          return {
            ...state,
            status: "ready",
            workspaces: [workspace, ...state.workspaces],
          };
        }
        const workspaces = [...state.workspaces];
        workspaces[existingIndex] = workspace;
        return { ...state, status: "ready", workspaces };
      });
    },
    remove(id: string) {
      revision += 1;
      update((state) => ({
        ...state,
        workspaces: state.workspaces.filter((item) => item.id !== id),
      }));
    },
    applyOrder(workspaceIds: string[]): boolean {
      const byId = new Map(
        current.workspaces.map((workspace) => [workspace.id, workspace]),
      );
      if (
        workspaceIds.length !== byId.size ||
        new Set(workspaceIds).size !== workspaceIds.length ||
        workspaceIds.some((id) => !byId.has(id))
      ) {
        void store.load();
        return false;
      }
      revision += 1;
      update((state) => ({
        ...state,
        status: "ready",
        workspaces: workspaceIds.map((id) => byId.get(id)!),
      }));
      return true;
    },
    async reorder(workspaceIds: string[]): Promise<void> {
      if (activeReorderOperation !== undefined) return;
      const expectedWorkspaces = current.workspaces;
      const expectedWorkspaceIds = expectedWorkspaces.map(
        (workspace) => workspace.id,
      );
      if (
        workspaceIds.length !== expectedWorkspaceIds.length ||
        new Set(workspaceIds).size !== workspaceIds.length ||
        workspaceIds.some((id) => !expectedWorkspaceIds.includes(id))
      ) {
        throw new Error("Workspace order must contain every workspace once");
      }
      if (
        workspaceIds.every((id, index) => expectedWorkspaceIds[index] === id)
      ) {
        return;
      }

      const byId = new Map(
        expectedWorkspaces.map((workspace) => [workspace.id, workspace]),
      );
      const operation = ++nextReorderOperation;
      activeReorderOperation = operation;
      reloadAfterReorder = false;
      revision += 1;
      const operationRevision = revision;
      update((state) => ({
        ...state,
        status: "ready",
        reordering: true,
        workspaces: workspaceIds.map((id) => byId.get(id)!),
      }));
      try {
        const response = await client.reorderWorkspaces({
          expectedWorkspaceIds,
          workspaceIds,
        });
        if (activeReorderOperation !== operation) return;
        activeReorderOperation = undefined;
        if (revision === operationRevision) {
          replaceWorkspaces(response.workspaces);
        } else {
          update((state) => ({ ...state, reordering: false }));
        }
        if (reloadAfterReorder) {
          reloadAfterReorder = false;
          await store.load();
        }
      } catch (error) {
        if (activeReorderOperation === operation) {
          activeReorderOperation = undefined;
          if (revision === operationRevision) {
            revision += 1;
            update((state) => ({
              ...state,
              status: "ready",
              reordering: false,
              workspaces: expectedWorkspaces,
            }));
          } else {
            update((state) => ({ ...state, reordering: false }));
          }
          reloadAfterReorder = false;
          await store.load();
        }
        throw error;
      }
    },
  };

  return store;
}

export const workspaceStore = createWorkspaceStore();
