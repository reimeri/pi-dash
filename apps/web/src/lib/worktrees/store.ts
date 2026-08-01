import type { WorktreeDto } from "@pi-dash/contracts";
import { writable } from "svelte/store";
import { api } from "../../api.js";

export interface WorktreeState {
  loadingWorkspaceId?: string;
  byWorkspace: Record<string, WorktreeDto[]>;
  message?: string;
}

function sortWorktrees(worktrees: WorktreeDto[]): WorktreeDto[] {
  return [...worktrees].sort(
    (left, right) =>
      Number(left.lifecycle === "removed") -
        Number(right.lifecycle === "removed") ||
      left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
        numeric: true,
      }) ||
      left.createdAt.localeCompare(right.createdAt),
  );
}

export function createWorktreeStore(
  client: Pick<typeof api, "worktrees" | "reconcileWorktrees"> = api,
) {
  const { subscribe, update } = writable<WorktreeState>({ byWorkspace: {} });
  const generations = new Map<string, number>();

  const replace = (workspaceId: string, worktrees: WorktreeDto[]) =>
    update((state) => ({
      ...state,
      loadingWorkspaceId: undefined,
      message: undefined,
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: sortWorktrees(worktrees),
      },
    }));

  return {
    subscribe,
    async load(workspaceId: string) {
      const generation = (generations.get(workspaceId) ?? 0) + 1;
      generations.set(workspaceId, generation);
      update((state) => ({
        ...state,
        loadingWorkspaceId: workspaceId,
        message: undefined,
      }));
      try {
        const response = await client.worktrees(workspaceId);
        if (generations.get(workspaceId) === generation) {
          replace(workspaceId, response.worktrees);
        }
      } catch (error) {
        if (generations.get(workspaceId) !== generation) return;
        update((state) => ({
          ...state,
          loadingWorkspaceId: undefined,
          message:
            error instanceof Error ? error.message : "Unable to load worktrees",
        }));
      }
    },
    async reconcile(workspaceId: string) {
      const response = await client.reconcileWorktrees(workspaceId);
      replace(workspaceId, response.worktrees);
    },
    upsert(worktree: WorktreeDto) {
      generations.set(
        worktree.workspaceId,
        (generations.get(worktree.workspaceId) ?? 0) + 1,
      );
      update((state) => ({
        ...state,
        byWorkspace: {
          ...state.byWorkspace,
          [worktree.workspaceId]: sortWorktrees([
            ...(state.byWorkspace[worktree.workspaceId] ?? []).filter(
              (item) => item.id !== worktree.id,
            ),
            worktree,
          ]),
        },
      }));
    },
    clearWorkspace(workspaceId: string) {
      update((state) => {
        const byWorkspace = { ...state.byWorkspace };
        delete byWorkspace[workspaceId];
        return { ...state, byWorkspace };
      });
    },
  };
}

export const worktreeStore = createWorktreeStore();
