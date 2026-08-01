<script lang="ts">
  import type { WorkspaceDto, WorktreeDto } from "@pi-dash/contracts";
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";

  export let workspaces: WorkspaceDto[];
  export let status: "idle" | "loading" | "ready" | "error";
  export let message: string | undefined;
  export let selectedId: string | undefined;
  export let selectedWorktreeId: string | undefined;
  export let worktreesByWorkspace: Record<string, WorktreeDto[]>;
  export let worktreeLoadingByWorkspace: Record<string, boolean>;
  export let worktreeErrorsByWorkspace: Record<string, string | undefined>;
  export let onSelect: (id: string) => void;
  export let onExpand: (id: string) => void;
  export let onSelectWorktree: (worktree: WorktreeDto) => void;

  const storageKey = "pi-dash.expanded-workspaces.v1";
  let expanded = new SvelteSet<string>();
  const requestedExpanded = new SvelteSet<string>();

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {
      // Local preference persistence is optional.
    }
  }

  function toggle(id: string) {
    const next = new SvelteSet(expanded);
    if (next.has(id)) {
      next.delete(id);
      requestedExpanded.delete(id);
    } else {
      next.add(id);
    }
    expanded = next;
    save();
  }

  function canOpenTerminal(worktree: WorktreeDto): boolean {
    return worktree.lifecycle === "ready" && worktree.health === "healthy";
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
      expanded = new SvelteSet(
        Array.isArray(stored)
          ? stored.filter((id): id is string => typeof id === "string")
          : [],
      );
    } catch {
      expanded = new SvelteSet();
    }
  });

  $: {
    for (const workspace of workspaces) {
      if (expanded.has(workspace.id) && !requestedExpanded.has(workspace.id)) {
        requestedExpanded.add(workspace.id);
        onExpand(workspace.id);
      }
    }
  }
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
          class:selected={selectedId === workspace.id && !selectedWorktreeId}
          class:degraded={workspace.repository.health !== "healthy"}
        >
          <div class="workspace-row">
            <button
              class="workspace-chevron"
              type="button"
              aria-label={`${expanded.has(workspace.id) ? "Collapse" : "Expand"} ${workspace.name}`}
              aria-expanded={expanded.has(workspace.id)}
              aria-controls={`workspace-panel-${workspace.id}`}
              on:click={() => toggle(workspace.id)}
            >
              <span class="chevron" aria-hidden="true"
                >{expanded.has(workspace.id) ? "⌄" : "›"}</span
              >
            </button>
            <button
              class="workspace-select"
              type="button"
              aria-current={selectedId === workspace.id && !selectedWorktreeId
                ? "page"
                : undefined}
              on:click={() => onSelect(workspace.id)}
            >
              <span class="workspace-copy">
                <strong>{workspace.name}</strong>
              </span>
              <span
                class={`health-dot health-${workspace.repository.health}`}
                title={healthLabel(workspace)}
                aria-label={healthLabel(workspace)}
              ></span>
            </button>
          </div>
          <div
            class="workspace-panel"
            id={`workspace-panel-${workspace.id}`}
            hidden={!expanded.has(workspace.id)}
          >
            {#if workspace.repository.health !== "healthy"}
              <p class="workspace-health" role="status">
                {healthLabel(workspace)}
              </p>
            {/if}
            {#if worktreeLoadingByWorkspace[workspace.id] && (worktreesByWorkspace[workspace.id] ?? []).length === 0}
              <p class="workspace-health" role="status">Loading worktrees…</p>
            {:else if worktreeErrorsByWorkspace[workspace.id]}
              <p class="workspace-worktree-error" role="alert">
                {worktreeErrorsByWorkspace[workspace.id]}
              </p>
            {:else if (worktreesByWorkspace[workspace.id] ?? []).length > 0}
              <ul
                class="worktree-sidebar-list"
                aria-label={`${workspace.name} managed worktrees`}
              >
                {#each worktreesByWorkspace[workspace.id] ?? [] as worktree (worktree.id)}
                  <li>
                    <button
                      type="button"
                      class:active={selectedWorktreeId === worktree.id}
                      disabled={!canOpenTerminal(worktree)}
                      title={canOpenTerminal(worktree)
                        ? `Open ${worktree.name} terminal`
                        : "Terminal unavailable until this worktree is ready and healthy"}
                      on:click={() => onSelectWorktree(worktree)}
                    >
                      <span
                        class={`worktree-state state-${worktree.health}`}
                        aria-hidden="true"
                      ></span>
                      <span><strong>{worktree.name}</strong></span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="workspace-health">No managed worktrees</p>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</nav>
