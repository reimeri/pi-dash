<script lang="ts">
  import type { WorkspaceDto, WorktreeDto } from "@pi-dash/contracts";
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { displayPath } from "./display.js";

  export let workspaces: WorkspaceDto[];
  export let status: "idle" | "loading" | "ready" | "error";
  export let message: string | undefined;
  export let selectedId: string | undefined;
  export let selectedWorktreeId: string | undefined;
  export let worktreesByWorkspace: Record<string, WorktreeDto[]>;
  export let onSelect: (id: string) => void;
  export let onSelectWorktree: (worktree: WorktreeDto) => void;
  export let onRename: (workspace: WorkspaceDto) => void;
  export let onRemove: (workspace: WorkspaceDto) => void;
  export let onRetry: (workspace: WorkspaceDto) => void;

  const storageKey = "pi-dash.expanded-workspaces.v1";
  const expanded = new SvelteSet<string>();

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {
      // Local preference persistence is optional.
    }
  }

  function toggle(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    save();
    onSelect(id);
  }

  function healthLabel(workspace: WorkspaceDto): string {
    switch (workspace.repository.health) {
      case "healthy":
        return "Healthy";
      case "missing":
        return "Repository missing";
      case "inaccessible":
        return "Repository inaccessible";
      case "not_git":
        return "No longer a Git worktree";
      case "changed":
        return "Repository identity changed";
    }
  }

  onMount(() => {
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem(storageKey) ?? "[]",
      );
      if (Array.isArray(stored)) {
        for (const id of stored) {
          if (typeof id === "string") expanded.add(id);
        }
      }
    } catch {
      expanded.clear();
    }
  });
</script>

<nav aria-label="Workspaces" class="workspace-nav">
  {#if status === "loading" && workspaces.length === 0}
    <div class="sidebar-loading" role="status">
      <span class="mini-spinner" aria-hidden="true"></span>Loading workspaces…
    </div>
  {:else if status === "error" && workspaces.length === 0}
    <div class="sidebar-message" role="alert">
      <strong>Workspaces unavailable</strong>
      <span>{message}</span>
    </div>
  {:else if workspaces.length === 0}
    <div class="sidebar-empty">
      <span class="empty-icon" aria-hidden="true">⌂</span>
      <p>No workspaces yet</p>
      <span>Add an existing local Git repository.</span>
    </div>
  {:else}
    {#if status === "error"}
      <p class="sidebar-inline-error" role="alert">{message}</p>
    {/if}
    <ul class="workspace-list">
      {#each workspaces as workspace (workspace.id)}
        <li
          class:selected={selectedId === workspace.id}
          class:degraded={workspace.repository.health !== "healthy"}
        >
          <button
            class="workspace-toggle"
            type="button"
            aria-expanded={expanded.has(workspace.id)}
            aria-controls={`workspace-panel-${workspace.id}`}
            on:click={() => toggle(workspace.id)}
          >
            <span class="chevron" aria-hidden="true"
              >{expanded.has(workspace.id) ? "⌄" : "›"}</span
            >
            <span class="workspace-copy">
              <strong>{workspace.name}</strong>
              <span
                >{workspace.repository.currentBranch ??
                  "Detached or unborn HEAD"}</span
              >
            </span>
            <span
              class={`health-dot health-${workspace.repository.health}`}
              title={healthLabel(workspace)}
              aria-label={healthLabel(workspace)}
            ></span>
          </button>
          <div
            class="workspace-panel"
            id={`workspace-panel-${workspace.id}`}
            hidden={!expanded.has(workspace.id)}
          >
            <p
              class="workspace-path"
              title={displayPath(workspace.repositoryPath)}
            >
              {displayPath(workspace.repositoryPath)}
            </p>
            {#if workspace.repository.health !== "healthy"}
              <p class="workspace-health" role="status">
                {healthLabel(workspace)}
              </p>
            {/if}
            {#if (worktreesByWorkspace[workspace.id] ?? []).length > 0}
              <ul
                class="worktree-sidebar-list"
                aria-label={`${workspace.name} managed worktrees`}
              >
                {#each worktreesByWorkspace[workspace.id] ?? [] as worktree (worktree.id)}
                  <li>
                    <button
                      type="button"
                      class:active={selectedWorktreeId === worktree.id}
                      on:click={() => onSelectWorktree(worktree)}
                    >
                      <span
                        class={`worktree-state state-${worktree.health}`}
                        aria-hidden="true"
                      ></span>
                      <span
                        ><strong>{worktree.name}</strong><small
                          >{worktree.lifecycle.replace("_", " ")} · {worktree.health.replace(
                            "_",
                            " ",
                          )}</small
                        ></span
                      >
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="workspace-health">No managed worktrees</p>
            {/if}
            <div class="workspace-actions">
              {#if workspace.repository.health !== "healthy"}
                <button type="button" on:click={() => onRetry(workspace)}
                  >Retry</button
                >
              {/if}
              <button type="button" on:click={() => onRename(workspace)}
                >Rename</button
              >
              <button type="button" on:click={() => onRemove(workspace)}
                >Remove</button
              >
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
