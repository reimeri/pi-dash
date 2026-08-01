import type { WorktreeDto } from "@pi-dash/contracts";
import { writable } from "svelte/store";
import { api } from "../../api.js";

export interface WorktreeState {
  loadingByWorkspace: Record<string, boolean>;
  errorsByWorkspace: Record<string, string | undefined>;
  byWorkspace: Record<string, WorktreeDto[]>;
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
  const { subscribe, update } = writable<WorktreeState>({
    loadingByWorkspace: {},
    errorsByWorkspace: {},
    byWorkspace: {},
  });
  const generations = new Map<string, number>();

  const replace = (workspaceId: string, worktrees: WorktreeDto[]) =>
    update((state) => ({
      ...state,
      loadingByWorkspace: {
        ...state.loadingByWorkspace,
        [workspaceId]: false,
      },
      errorsByWorkspace: {
        ...state.errorsByWorkspace,
        [workspaceId]: undefined,
      },
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
        loadingByWorkspace: {
          ...state.loadingByWorkspace,
          [workspaceId]: true,
        },
        errorsByWorkspace: {
          ...state.errorsByWorkspace,
          [workspaceId]: undefined,
        },
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
          loadingByWorkspace: {
            ...state.loadingByWorkspace,
            [workspaceId]: false,
          },
          errorsByWorkspace: {
            ...state.errorsByWorkspace,
            [workspaceId]:
              error instanceof Error
                ? error.message
                : "Unable to load worktrees",
          },
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
        loadingByWorkspace: {
          ...state.loadingByWorkspace,
          [worktree.workspaceId]: false,
        },
        errorsByWorkspace: {
          ...state.errorsByWorkspace,
          [worktree.workspaceId]: undefined,
        },
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
        const loadingByWorkspace = { ...state.loadingByWorkspace };
        const errorsByWorkspace = { ...state.errorsByWorkspace };
        delete byWorkspace[workspaceId];
        delete loadingByWorkspace[workspaceId];
        delete errorsByWorkspace[workspaceId];
        return {
          ...state,
          byWorkspace,
          loadingByWorkspace,
          errorsByWorkspace,
        };
      });
    },
  };
}

export const worktreeStore = createWorktreeStore();
