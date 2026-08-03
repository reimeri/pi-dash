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
    Folder
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onDestroy, onMount } from "svelte";
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
  export let reordering: boolean;
  export let onReorder: (workspaceIds: string[]) => Promise<void>;
  export let onCreateWorktree: (workspace: WorkspaceDto) => void;
  export let onSelectWorktree: (worktree: WorktreeDto) => void;

  const sidebar = Sidebar.useSidebar();
  const storageKey = "pi-dash.expanded-workspaces.v1";
  let expanded = new SvelteSet<string>();
  const requestedExpanded = new SvelteSet<string>();
  interface WorkspaceDragCandidate {
    element: HTMLElement;
    pointerId: number;
    pointerType: string;
    startX: number;
    startY: number;
    workspaceId: string;
    activationTimer?: ReturnType<typeof setTimeout>;
  }

  let dragging = false;
  let renderedWorkspaces = workspaces;
  let dragCandidate: WorkspaceDragCandidate | undefined;
  let ignoreWorkspaceClickId: string | undefined;

  function moveWorkspace(
    items: WorkspaceDto[],
    sourceId: string,
    targetId: string,
    insertAfter: boolean,
  ): WorkspaceDto[] {
    const sourceIndex = items.findIndex(
      (workspace) => workspace.id === sourceId,
    );
    let targetIndex = items.findIndex(
      (workspace) => workspace.id === targetId,
    );
    if (
      sourceIndex === -1 ||
      targetIndex === -1 ||
      sourceIndex === targetIndex
    ) {
      return items;
    }
    const next = [...items];
    const [source] = next.splice(sourceIndex, 1);
    if (sourceIndex < targetIndex) {
      targetIndex -= 1;
    }
    const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
    next.splice(insertIndex, 0, source!);
    return next;
  }

  function workspaceOrderEqual(
    left: WorkspaceDto[],
    right: WorkspaceDto[],
  ): boolean {
    return (
      left.length === right.length &&
      left.every((workspace, index) => workspace.id === right[index]?.id)
    );
  }

  function clearDragCandidate(): void {
    if (!dragCandidate) return;
    clearTimeout(dragCandidate.activationTimer);
    if (dragCandidate.element.hasPointerCapture(dragCandidate.pointerId)) {
      dragCandidate.element.releasePointerCapture(dragCandidate.pointerId);
    }
    dragCandidate = undefined;
  }

  function activateWorkspaceDrag(candidate: WorkspaceDragCandidate): void {
    if (dragCandidate !== candidate || dragging) return;
    clearTimeout(candidate.activationTimer);
    candidate.activationTimer = undefined;
    dragging = true;
    renderedWorkspaces = [...workspaces];
  }

  function handleWorkspacePointerDown(
    event: PointerEvent,
    workspaceId: string,
  ): void {
    if (
      reordering ||
      renderedWorkspaces.length < 2 ||
      !event.isPrimary ||
      event.button !== 0
    ) {
      return;
    }

    clearDragCandidate();
    const element = event.currentTarget;
    if (!(element instanceof HTMLElement)) return;

    const candidate: WorkspaceDragCandidate = {
      element,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      workspaceId,
    };
    dragCandidate = candidate;
    element.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch") {
      candidate.activationTimer = setTimeout(
        () => activateWorkspaceDrag(candidate),
        500,
      );
    }
  }

  function handleWorkspacePointerMove(event: PointerEvent): void {
    const candidate = dragCandidate;
    if (!candidate || event.pointerId !== candidate.pointerId) return;

    if (!dragging) {
      const distance = Math.hypot(
        event.clientX - candidate.startX,
        event.clientY - candidate.startY,
      );
      if (candidate.pointerType === "touch") {
        if (distance > 8) clearDragCandidate();
        return;
      }
      if (distance < 5) return;
      activateWorkspaceDrag(candidate);
    }

    event.preventDefault();
    const targetElement = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-workspace-id]");
    const targetId = targetElement?.dataset.workspaceId;
    if (!targetId) return;

    const targetRect = targetElement.getBoundingClientRect();
    const insertAfter =
      event.clientY >= targetRect.top + targetRect.height / 2;
    const nextWorkspaces = moveWorkspace(
      renderedWorkspaces,
      candidate.workspaceId,
      targetId,
      insertAfter,
    );
    if (!workspaceOrderEqual(nextWorkspaces, renderedWorkspaces)) {
      renderedWorkspaces = nextWorkspaces;
    }
  }

  function handleWorkspacePointerUp(event: PointerEvent): void {
    const candidate = dragCandidate;
    if (!candidate || event.pointerId !== candidate.pointerId) return;

    if (!dragging) {
      clearDragCandidate();
      return;
    }

    const workspaceIds = renderedWorkspaces.map((workspace) => workspace.id);
    const orderChanged = workspaceIds.some(
      (workspaceId, index) => workspaceId !== workspaces[index]?.id,
    );
    ignoreWorkspaceClickId = candidate.workspaceId;
    dragging = false;
    clearDragCandidate();
    setTimeout(() => {
      if (ignoreWorkspaceClickId === candidate.workspaceId) {
        ignoreWorkspaceClickId = undefined;
      }
    });

    if (orderChanged) void onReorder(workspaceIds);
    else renderedWorkspaces = workspaces;
  }

  function cancelWorkspaceDrag(event: PointerEvent | undefined): void {
    if (event && dragCandidate && event.pointerId !== dragCandidate.pointerId) {
      return;
    }
    dragging = false;
    renderedWorkspaces = workspaces;
    clearDragCandidate();
  }

  function handleDragKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !dragging) return;
    event.preventDefault();
    cancelWorkspaceDrag(undefined);
  }

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

  function handleWorkspaceClick(event: MouseEvent, id: string): void {
    if (ignoreWorkspaceClickId === id) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ignoreWorkspaceClickId = undefined;
      return;
    }
    selectWorkspace(id);
  }

  function handleWorkspaceKeydown(event: KeyboardEvent, id: string): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selectWorkspace(id);
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

  onDestroy(() => clearDragCandidate());

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

  $: if (!dragging) renderedWorkspaces = workspaces;

  $: {
    for (const workspace of renderedWorkspaces) {
      if (expanded.has(workspace.id) && !requestedExpanded.has(workspace.id)) {
        requestedExpanded.add(workspace.id);
        onExpand(workspace.id);
      }
    }
  }

  $: onVisibleWorktreesChange(
    renderedWorkspaces.flatMap((workspace) =>
      expanded.has(workspace.id)
        ? (worktreesByWorkspace[workspace.id] ?? [])
            .filter(canOpenTerminal)
            .map((worktree) => worktree.id)
        : [],
    ),
  );
</script>

<svelte:window
  onpointermove={handleWorkspacePointerMove}
  onpointerup={handleWorkspacePointerUp}
  onpointercancel={cancelWorkspaceDrag}
  onkeydown={handleDragKeydown}
/>

<nav aria-label="Workspaces" class="min-h-0 flex-1 overflow-y-auto px-2 py-1">
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
      {#each renderedWorkspaces as workspace (workspace.id)}
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
          <Sidebar.MenuItem
            data-workspace-id={workspace.id}
            data-dragging={dragging &&
            dragCandidate?.workspaceId === workspace.id
              ? "true"
              : undefined}
            class={cn(
              "transition-[opacity,transform] motion-reduce:transition-none",
              dragging &&
                dragCandidate?.workspaceId === workspace.id &&
                "opacity-60",
            )}
          >
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
                    <span class="relative size-4 shrink-0" aria-hidden="true">
                      <HugeiconsIcon
                        icon={Folder}
                        class="size-4 group-hover/workspace:opacity-0 group-focus-visible/button:opacity-0"
                        strokeWidth={2}
                      />
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        class={cn(
                          "pointer-events-none absolute inset-0 size-4 opacity-0 transition-[opacity,transform] group-hover/workspace:opacity-100 group-focus-visible/button:opacity-100",
                          expanded.has(workspace.id) && "rotate-90",
                        )}
                        strokeWidth={2}
                      />
                    </span>
                  </Button>
                {/snippet}
              </Collapsible.Trigger>
              <Sidebar.MenuButton
                class={cn(
                  "touch-pan-y select-none hover:bg-muted dark:hover:bg-muted/50 data-active:hover:bg-sidebar-accent",
                  dragging &&
                    dragCandidate?.workspaceId === workspace.id &&
                    "cursor-grabbing",
                )}
                data-workspace-drag-surface
                title="Drag to rearrange workspace"
                isActive={selectedId === workspace.id && !selectedWorktreeId}
                aria-current={selectedId === workspace.id && !selectedWorktreeId
                  ? "page"
                  : undefined}
                aria-label={workspaceLabel(workspace)}
                onpointerdown={(event) =>
                  handleWorkspacePointerDown(event, workspace.id)}
                onkeydown={(event) =>
                  handleWorkspaceKeydown(event, workspace.id)}
                onclick={(event) => handleWorkspaceClick(event, workspace.id)}
              >
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
                        <span class={cn("min-w-0 flex-1 truncate text-left",
                          workflowStatuses[worktree.id]?.integration !== "connected" && "opacity-50"
                        )}
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
