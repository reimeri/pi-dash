<script lang="ts">
  import type {
    WorkflowStatusDto,
    WorktreeDiffSummary,
    WorkspaceAttentionDto,
    WorkspaceDto,
    WorktreeDto,
  } from "@pi-dash/contracts";
  import {
    Add01Icon,
    ArrowRight01Icon,
    FolderGitIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import * as Empty from "$lib/components/ui/empty";
  import * as Sidebar from "$lib/components/ui/sidebar";
  import { Spinner } from "$lib/components/ui/spinner";
  import WorkflowStatusIndicator from "../status/WorkflowStatusIndicator.svelte";
  import WorkspaceSyncIndicator from "./WorkspaceSyncIndicator.svelte";
  import { orderWorktreesByActivity } from "../worktrees/order.js";
  import { cn } from "tailwind-variants";

  export let workspaces: WorkspaceDto[];
  export let status: "idle" | "loading" | "ready" | "error";
  export let message: string | undefined;
  export let selectedId: string | undefined;
  export let selectedWorktreeId: string | undefined;
  export let worktreesByWorkspace: Record<string, WorktreeDto[]>;
  export let worktreeLoadingByWorkspace: Record<string, boolean>;
  export let worktreeErrorsByWorkspace: Record<string, string | undefined>;
  export let workflowStatuses: Record<string, WorkflowStatusDto>;
  export let diffSummaries: Record<string, WorktreeDiffSummary>;
  export let workspaceAttentionStatuses: WorkspaceAttentionDto[];
  export let statusChannel: "connecting" | "connected" | "disconnected";
  export let onSelect: (id: string) => void;
  export let onExpand: (id: string) => void;
  export let onVisibleWorktreesChange: (ids: string[]) => void;
  export let onCreateWorktree: (workspace: WorkspaceDto) => void;
  export let onSelectWorktree: (worktree: WorktreeDto) => void;

  const sidebar = Sidebar.useSidebar();
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

  function setExpanded(id: string, open: boolean) {
    const next = new SvelteSet(expanded);
    if (open) next.add(id);
    else {
      next.delete(id);
      requestedExpanded.delete(id);
    }
    expanded = next;
    save();
  }

  function closeMobileSidebar(): void {
    if (sidebar.isMobile) sidebar.setOpenMobile(false);
  }

  function selectWorkspace(id: string): void {
    closeMobileSidebar();
    onSelect(id);
  }

  function createWorktree(workspace: WorkspaceDto): void {
    closeMobileSidebar();
    onCreateWorktree(workspace);
  }

  function selectWorktree(worktree: WorktreeDto): void {
    closeMobileSidebar();
    onSelectWorktree(worktree);
  }

  function canOpenTerminal(worktree: WorktreeDto): boolean {
    return worktree.lifecycle === "ready" && worktree.health === "healthy";
  }

  function worktreeLabel(worktree: WorktreeDto): string {
    const summary = diffSummaries[worktree.id];
    if (!summary?.hasChanges) return worktree.name;
    return `${worktree.name}, ${summary.additions} added lines, ${summary.deletions} deleted lines`;
  }

  function workspaceLabel(workspace: WorkspaceDto): string {
    if (workspace.repository.syncStatus === "syncable") {
      return `${workspace.name}, upstream updates available`;
    }
    if (workspace.repository.syncStatus === "diverged") {
      return `${workspace.name}, branch diverged from upstream`;
    }
    return workspace.name;
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

  $: onVisibleWorktreesChange(
    workspaces.flatMap((workspace) =>
      expanded.has(workspace.id)
        ? (worktreesByWorkspace[workspace.id] ?? [])
            .filter(canOpenTerminal)
            .map((worktree) => worktree.id)
        : [],
    ),
  );
</script>

<nav aria-label="Workspaces" class="min-h-0 flex-1 overflow-y-auto px-2">
  {#if status === "loading" && workspaces.length === 0}
    <div
      class="flex items-center gap-2 p-3 text-sm text-muted-foreground"
      role="status"
    >
      <Spinner aria-hidden="true" />
      Loading workspaces…
    </div>
  {:else if status === "error" && workspaces.length === 0}
    <Alert.Root variant="destructive">
      <Alert.Title>Workspaces unavailable</Alert.Title>
      <Alert.Description>{message}</Alert.Description>
    </Alert.Root>
  {:else if workspaces.length === 0}
    <Empty.Root class="border-none p-4">
      <Empty.Header>
        <Empty.Media variant="icon">
          <HugeiconsIcon icon={FolderGitIcon} strokeWidth={2} />
        </Empty.Media>
        <Empty.Title role="heading" aria-level={2}
          >No workspaces yet</Empty.Title
        >
        <Empty.Description
          >Add an existing local Git repository.</Empty.Description
        >
      </Empty.Header>
    </Empty.Root>
  {:else}
    {#if status === "error"}
      <Alert.Root variant="destructive" class="mb-2">
        <Alert.Description>{message}</Alert.Description>
      </Alert.Root>
    {/if}
    <Sidebar.Menu>
      {#each workspaces as workspace (workspace.id)}
        {@const activity = workspaceAttentionStatuses.find(
          (attention) => attention.workspaceId === workspace.id,
        )}
        {@const orderedWorktrees = orderWorktreesByActivity(
          worktreesByWorkspace[workspace.id] ?? [],
          workflowStatuses,
        )}
        <Collapsible.Root
          open={expanded.has(workspace.id)}
          onOpenChange={(open) => setExpanded(workspace.id, open)}
        >
          <Sidebar.MenuItem>
            <div class="group/workspace flex items-center gap-1">
              <Collapsible.Trigger>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    variant="ghost_no_expand"
                    size="icon-sm"
                    aria-label={`${expanded.has(workspace.id) ? "Collapse" : "Expand"} ${workspace.name}`}
                    aria-controls={`workspace-panel-${workspace.id}`}
                  >
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      class={cn(
                        "transition-transform",
                        expanded.has(workspace.id) && "rotate-90",
                      )}
                      strokeWidth={2}
                    />
                  </Button>
                {/snippet}
              </Collapsible.Trigger>
              <Sidebar.MenuButton
                isActive={selectedId === workspace.id && !selectedWorktreeId}
                aria-current={selectedId === workspace.id && !selectedWorktreeId
                  ? "page"
                  : undefined}
                aria-label={workspaceLabel(workspace)}
                onclick={() => selectWorkspace(workspace.id)}
              >
                <HugeiconsIcon
                  icon={FolderGitIcon}
                  strokeWidth={2}
                  aria-hidden="true"
                />
                <span class="min-w-0 flex-1 truncate">{workspace.name}</span>
                <WorkspaceSyncIndicator
                  status={workspace.repository.syncStatus}
                />
                {#if !expanded.has(workspace.id) && statusChannel === "connected" && activity && activity.state !== "idle" && activity.integration === "connected"}
                  <WorkflowStatusIndicator
                    stateOverride={activity.state}
                    integrationOverride={activity.integration}
                    aggregateCount={activity.count}
                    labelPrefix={`${workspace.name} workflow`}
                    channel={statusChannel}
                  />
                {/if}
              </Sidebar.MenuButton>
              <Button
                class="focus-within:opacity-100 group-hover/workspace:opacity-100 md:opacity-0"
                variant="ghost"
                size="icon-sm"
                disabled={workspace.repository.health !== "healthy"}
                aria-label={`New worktree in ${workspace.name}`}
                aria-describedby={workspace.repository.health !== "healthy"
                  ? `workspace-health-${workspace.id}`
                  : undefined}
                onclick={() => createWorktree(workspace)}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              </Button>
            </div>
            <Collapsible.Content id={`workspace-panel-${workspace.id}`}>
              <Sidebar.MenuSub>
                {#if workspace.repository.health !== "healthy"}
                  <li
                    id={`workspace-health-${workspace.id}`}
                    class="px-3 py-1 text-xs text-destructive"
                    role="status"
                  >
                    {healthLabel(workspace)}
                  </li>
                {/if}
                {#if worktreeLoadingByWorkspace[workspace.id] && orderedWorktrees.length === 0}
                  <li
                    class="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground"
                    role="status"
                  >
                    <Spinner aria-hidden="true" />
                    Loading worktrees…
                  </li>
                {:else if worktreeErrorsByWorkspace[workspace.id]}
                  <li class="px-3 py-1 text-xs text-destructive" role="alert">
                    {worktreeErrorsByWorkspace[workspace.id]}
                  </li>
                {:else if orderedWorktrees.length > 0}
                  {#each orderedWorktrees as worktree (worktree.id)}
                    {@const diffSummary = diffSummaries[worktree.id]}
                    <Sidebar.MenuSubItem>
                      <Button
                        class="w-full min-w-0 justify-start"
                        variant={selectedWorktreeId === worktree.id
                          ? "secondary"
                          : "ghost"}
                        size="sm"
                        disabled={!canOpenTerminal(worktree)}
                        aria-label={worktreeLabel(worktree)}
                        title={canOpenTerminal(worktree)
                          ? `Open ${worktree.name} terminal`
                          : "Terminal unavailable until this worktree is ready and healthy"}
                        onclick={() => selectWorktree(worktree)}
                      >
                        <WorkflowStatusIndicator
                          status={workflowStatuses[worktree.id]}
                          labelPrefix={`${worktree.name} workflow`}
                          channel={statusChannel}
                        />
                        <span class="min-w-0 flex-1 truncate text-left"
                          >{worktree.name}</span
                        >
                        {#if diffSummary?.hasChanges}
                          <span
                            class="ml-auto flex shrink-0 items-center gap-1 text-[0.625rem] leading-none tabular-nums"
                            aria-hidden="true"
                          >
                            <span class="text-diff-addition"
                              >+{diffSummary.additions}</span
                            >
                            <span class="text-diff-deletion"
                              >−{diffSummary.deletions}</span
                            >
                          </span>
                        {/if}
                      </Button>
                    </Sidebar.MenuSubItem>
                  {/each}
                {:else}
                  <li class="px-3 py-1 text-xs text-muted-foreground">
                    No managed worktrees
                  </li>
                {/if}
              </Sidebar.MenuSub>
            </Collapsible.Content>
          </Sidebar.MenuItem>
        </Collapsible.Root>
      {/each}
    </Sidebar.Menu>
  {/if}
</nav>
