<script lang="ts">
  import type { WorkspaceDto, WorktreeDto } from "@pi-dash/contracts";
  import { onDestroy, onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import {
    Add01Icon,
    AlertCircleIcon,
    ArrowReloadHorizontalIcon,
    Cancel01Icon,
    CheckmarkCircle02Icon,
    ComputerTerminal01Icon,
    Delete02Icon,
    Edit02Icon,
    ExternalLinkIcon,
    FolderGitIcon,
    GitBranchIcon,
    PlayIcon,
    PlusMinus01Icon,
    RefreshIcon,
    StopIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import * as Popover from "$lib/components/ui/popover";
  import * as Resizable from "$lib/components/ui/resizable";
  import { Separator } from "$lib/components/ui/separator";
  import * as Sheet from "$lib/components/ui/sheet";
  import * as Sidebar from "$lib/components/ui/sidebar";
  import { Spinner } from "$lib/components/ui/spinner";
  import { cn } from "$lib/utils";
  import { ApiClientError, api } from "./api.js";
  import DiffWorkspace from "./lib/diff/DiffWorkspace.svelte";
  import {
    createCoordinatedWorktreeDiffClient,
    createWorktreeDiffStore,
    createWorktreeDiffSummaryStore,
    type WorktreeDiffState,
  } from "./lib/diff/store.js";
  import { IsMobile } from "./lib/hooks/is-mobile.svelte.js";
  import {
    initialStartupState,
    reduceStartupState,
    type StartupState,
  } from "./connection.js";
  import AddWorkspaceDialog from "./lib/workspaces/AddWorkspaceDialog.svelte";
  import RemoveWorkspaceDialog from "./lib/workspaces/RemoveWorkspaceDialog.svelte";
  import RenameWorkspaceDialog from "./lib/workspaces/RenameWorkspaceDialog.svelte";
  import WorkspaceSidebar from "./lib/workspaces/WorkspaceSidebar.svelte";
  import WorkspaceSidebarAddButton from "./lib/workspaces/WorkspaceSidebarAddButton.svelte";
  import { workspaceStore } from "./lib/workspaces/store.js";
  import { displayPath } from "./lib/workspaces/display.js";
  import type { TerminalControls } from "./lib/terminal/controls.js";
  import LazyTerminalWorkspace from "./lib/terminal/LazyTerminalWorkspace.svelte";
  import {
    createStatusEventClient,
    type StatusEventClient,
  } from "./lib/status/events.js";
  import { workflowStatusStore } from "./lib/status/store.js";
  import CreateWorktreeDialog from "./lib/worktrees/CreateWorktreeDialog.svelte";
  import DeleteBranchDialog from "./lib/worktrees/DeleteBranchDialog.svelte";
  import RemoveWorktreeDialog from "./lib/worktrees/RemoveWorktreeDialog.svelte";
  import { worktreeStore } from "./lib/worktrees/store.js";

  let startup: StartupState = initialStartupState;
  let nativeDialogAvailable = false;
  let terminalCacheSize = 3;
  let terminalMaxFrameBytes = 64 * 1024;
  let showAdd = false;
  let renameTarget: WorkspaceDto | undefined;
  let removeTarget: WorkspaceDto | undefined;
  let selectedId: string | undefined;
  let workspaceActionError = "";
  let refreshingId: string | undefined;
  let selectedWorktreeId: string | undefined;
  let visibleDiffWorktreeIds: string[] = [];
  let createWorktreeTarget: WorkspaceDto | undefined;
  let removeWorktreeTarget: WorktreeDto | undefined;
  let deleteBranchTarget: WorktreeDto | undefined;
  let terminalControls: TerminalControls | undefined;
  let terminalMenuOpen = false;
  let focusTerminalAfterMenuClose = false;
  let mainContent: HTMLDivElement | null = null;
  let reconciling = false;
  let statusEvents: StatusEventClient | undefined;
  const acknowledgements = new SvelteMap<string, number>();
  const diffClient = createCoordinatedWorktreeDiffClient(api);
  const diffStore = createWorktreeDiffStore(diffClient);
  const sidebarDiffSummaryStore = createWorktreeDiffSummaryStore(diffClient);
  const isMobile = new IsMobile();
  $: selectedWorkspace = $workspaceStore.workspaces.find(
    (workspace) => workspace.id === selectedId,
  );
  $: selectedWorktrees = selectedWorkspace
    ? ($worktreeStore.byWorkspace[selectedWorkspace.id] ?? [])
    : [];
  $: selectedWorktree = selectedWorktreeId
    ? selectedWorktrees.find((worktree) => worktree.id === selectedWorktreeId)
    : undefined;
  $: liveTerminalWorktreeIds = Object.values($worktreeStore.byWorkspace)
    .flat()
    .filter(canOpenTerminal)
    .map((worktree) => worktree.id);
  $: sidebarDiffSummaryStore.track(
    visibleDiffWorktreeIds.filter((id) => id !== selectedWorktreeId),
  );
  $: sidebarDiffSummaries =
    selectedWorktreeId && $diffStore.summary?.worktreeId === selectedWorktreeId
      ? {
          ...$sidebarDiffSummaryStore,
          [selectedWorktreeId]: $diffStore.summary,
        }
      : $sidebarDiffSummaryStore;
  $: selectedWorkflowStatus = selectedWorktreeId
    ? $workflowStatusStore.byWorktree[selectedWorktreeId]
    : undefined;
  $: terminalOpen =
    startup.status === "ready" &&
    !!selectedWorktree &&
    canOpenTerminal(selectedWorktree);
  $: diffAvailable = terminalOpen;
  $: diffStore.select(
    diffAvailable && selectedWorktree ? selectedWorktree.id : undefined,
  );
  $: if (!terminalOpen) {
    terminalControls = undefined;
    terminalMenuOpen = false;
  }

  async function connect() {
    startup = reduceStartupState(startup, { type: "CONNECT" });
    try {
      const health = await api.health();
      nativeDialogAvailable =
        health.capabilities.nativeDirectoryDialog === "available";
      terminalCacheSize = health.settings.terminalCacheSize;
      terminalMaxFrameBytes = health.settings.terminalMaxFrameBytes;
      if (health.status === "migration-failed") {
        startup = reduceStartupState(startup, { type: "MIGRATION_FAILED" });
        return;
      }
      await api.session();
      statusEvents ??= createStatusEventClient({
        onWorktreeRemoved: removeWorktree,
        onSnapshot: () => {
          for (const workspaceId of Object.keys($worktreeStore.byWorkspace)) {
            void worktreeStore.load(workspaceId);
          }
        },
      });
      statusEvents.start();
      await workspaceStore.load();
      startup = reduceStartupState(startup, { type: "READY" });
      if (selectedId) await worktreeStore.load(selectedId);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        startup = reduceStartupState(startup, { type: "UNAUTHORIZED" });
      } else if (
        error instanceof ApiClientError &&
        error.envelope?.error.code === "MIGRATION_REQUIRED"
      ) {
        startup = reduceStartupState(startup, {
          type: "MIGRATION_FAILED",
          message: error.message,
        });
      } else {
        startup = reduceStartupState(startup, { type: "DISCONNECTED" });
      }
    }
  }

  function upsert(workspace: WorkspaceDto) {
    workspaceStore.upsert(workspace);
    selectedId = workspace.id;
    workspaceActionError = "";
  }

  function removeWorkspace(id: string) {
    workspaceStore.remove(id);
    worktreeStore.clearWorkspace(id);
    workflowStatusStore.reset();
    statusEvents?.close();
    statusEvents?.start();
    if (selectedId === id) {
      selectedId = undefined;
      selectedWorktreeId = undefined;
    }
    workspaceActionError = "";
  }

  async function refresh(workspace: WorkspaceDto) {
    refreshingId = workspace.id;
    workspaceActionError = "";
    try {
      const response = await api.refreshWorkspace(workspace.id);
      upsert(response.workspace);
    } catch (error) {
      workspaceActionError =
        error instanceof Error
          ? error.message
          : "Unable to refresh repository health.";
    } finally {
      refreshingId = undefined;
    }
  }

  function focusExisting(id: string) {
    selectWorkspace(id);
    showAdd = false;
  }

  function selectWorkspace(id: string) {
    selectedId = id;
    selectedWorktreeId = undefined;
    void worktreeStore.load(id);
  }

  function loadWorkspaceWorktrees(id: string) {
    void worktreeStore.load(id);
  }

  function trackVisibleDiffWorktrees(ids: string[]): void {
    visibleDiffWorktreeIds = ids;
  }

  function openCreateWorktree(workspace: WorkspaceDto) {
    createWorktreeTarget = workspace;
  }

  function canOpenTerminal(worktree: WorktreeDto): boolean {
    return worktree.lifecycle === "ready" && worktree.health === "healthy";
  }

  function selectWorktree(worktree: WorktreeDto) {
    if (!canOpenTerminal(worktree)) return;
    selectedId = worktree.workspaceId;
    selectedWorktreeId = worktree.id;
    requestAnimationFrame(() => acknowledgeWorkflow(worktree.id));
  }

  function acknowledgeWorkflow(worktreeId: string, explicit = false): void {
    const status = workflowStatusStore.current().byWorktree[worktreeId];
    if (!status || status.state !== "done") return;
    if (acknowledgements.get(worktreeId) === status.revision) return;
    acknowledgements.set(worktreeId, status.revision);
    void api
      .acknowledgeStatus(worktreeId, { revision: status.revision })
      .catch((error) => {
        // A newer event snapshot is authoritative; late automatic acknowledgements are safe to ignore.
        if (explicit) {
          workspaceActionError =
            error instanceof Error
              ? error.message
              : "Unable to acknowledge workflow completion.";
        }
      })
      .finally(() => {
        if (acknowledgements.get(worktreeId) === status.revision) {
          acknowledgements.delete(worktreeId);
        }
      });
  }

  function diffButtonLabel(state: WorktreeDiffState): string {
    if (state.status === "loading" && !state.summary) return "Checking changes";
    if (state.status === "error" && !state.summary) {
      return "View changes; the latest change count is unavailable";
    }
    const summary = state.summary;
    if (!summary?.hasChanges) return "View changes: no changes";
    return `View changes: ${summary.additions} added lines, ${summary.deletions} deleted lines across ${summary.filesChanged} ${summary.filesChanged === 1 ? "file" : "files"}`;
  }

  function terminalInputStatus(controls: TerminalControls | undefined): string {
    if (!controls || controls.socketState === "connecting") return "Connecting";
    if (controls.socketState === "disconnected") return "Disconnected";
    if (!controls.inputOwnerKnown) return "Negotiating";
    return controls.inputOwner ? "Interactive" : "Observer only";
  }

  function handleTerminalControlsChange(
    controls: TerminalControls | undefined,
  ): void {
    terminalControls = controls;
  }

  function handleTerminalMenuCloseAutoFocus(event: Event): void {
    if (!focusTerminalAfterMenuClose) return;
    event.preventDefault();
    focusTerminalAfterMenuClose = false;
    terminalControls?.focus();
  }

  function upsertWorktree(worktree: WorktreeDto) {
    worktreeStore.upsert(worktree);
    if (
      worktree.lifecycle === "removed" &&
      selectedWorktreeId === worktree.id
    ) {
      selectedWorktreeId = undefined;
    }
    workspaceActionError = "";
    void workspaceStore.load();
  }

  function removeWorktree(workspaceId: string, worktreeId: string) {
    worktreeStore.remove(workspaceId, worktreeId);
    workflowStatusStore.removeWorktrees([worktreeId]);
    if (selectedWorktreeId === worktreeId) selectedWorktreeId = undefined;
    if (removeWorktreeTarget?.id === worktreeId) {
      removeWorktreeTarget = undefined;
    }
    if (deleteBranchTarget?.id === worktreeId) deleteBranchTarget = undefined;
    workspaceActionError = "";
    void workspaceStore.load();
  }

  async function reconcileWorktrees() {
    if (!selectedWorkspace) return;
    reconciling = true;
    workspaceActionError = "";
    try {
      await worktreeStore.reconcile(selectedWorkspace.id);
      await workspaceStore.load();
    } catch (error) {
      workspaceActionError =
        error instanceof Error
          ? error.message
          : "Unable to reconcile worktrees.";
    } finally {
      reconciling = false;
    }
  }

  onMount(() => {
    void connect();
  });

  onDestroy(() => {
    statusEvents?.close();
    diffStore.destroy();
    sidebarDiffSummaryStore.destroy();
  });
</script>

<svelte:head><title>Pi Dash</title></svelte:head>

<a
  class="fixed left-3 top-2 z-50 -translate-y-20 rounded-md bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md focus:translate-y-0"
  href="#main-content"
>
  Skip to main content
</a>
<div class="grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
  <header class="flex h-13 items-center justify-between border-b bg-card px-4">
    <div
      class="flex items-center gap-2 text-sm font-medium"
      aria-label="Pi Dash home"
    >
      <span
        class="flex size-7 items-center justify-center rounded-lg border bg-background"
        aria-hidden="true">π</span
      >
      <span>Pi Dash</span>
    </div>
    <div class="flex min-w-0 items-center gap-2">
      {#if diffAvailable}
        <Button
          variant={$diffStore.open ? "secondary" : "outline"}
          size={$diffStore.summary?.hasChanges ? "sm" : "icon-sm"}
          aria-label={diffButtonLabel($diffStore)}
          aria-expanded={$diffStore.open}
          aria-controls="worktree-diff-viewer"
          title={diffButtonLabel($diffStore)}
          onclick={() => diffStore.setOpen(!$diffStore.open)}
        >
          {#if $diffStore.status === "loading" && !$diffStore.summary}
            <Spinner />
          {:else if $diffStore.summary?.hasChanges}
            <span class="text-diff-addition"
              >+{$diffStore.summary.additions}</span
            >
            <span class="text-diff-deletion"
              >−{$diffStore.summary.deletions}</span
            >
          {:else}
            <HugeiconsIcon icon={PlusMinus01Icon} strokeWidth={2} />
          {/if}
        </Button>
      {/if}
      {#if terminalOpen}
        <Popover.Root bind:open={terminalMenuOpen}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <Button
                {...props}
                variant="outline"
                size="sm"
                aria-label="Terminal"
              >
                <HugeiconsIcon
                  icon={ComputerTerminal01Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                Terminal
              </Button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content
            align="end"
            class="w-80"
            aria-label="Terminal controls"
            onCloseAutoFocus={handleTerminalMenuCloseAutoFocus}
          >
            <Popover.Header>
              <Popover.Title>Terminal controls</Popover.Title>
              <Popover.Description
                >Runtime, connection, and workflow status.</Popover.Description
              >
            </Popover.Header>
            <div class="flex flex-col gap-3" aria-live="polite">
              <div class="grid grid-cols-2 gap-2 text-sm">
                <span class="text-muted-foreground">Runtime</span>
                <Badge
                  variant={terminalControls?.runtimeState === "running"
                    ? "secondary"
                    : terminalControls?.runtimeState === "crashed"
                      ? "destructive"
                      : "outline"}
                >
                  {terminalControls?.runtimeState ?? "starting"}
                </Badge>
                <span class="text-muted-foreground">Socket</span>
                <Badge
                  variant={terminalControls?.socketState === "connected"
                    ? "secondary"
                    : terminalControls?.socketState === "disconnected"
                      ? "destructive"
                      : "outline"}
                >
                  {terminalControls?.socketState ?? "connecting"}
                </Badge>
                <span class="text-muted-foreground">Input</span>
                <Badge variant="secondary">
                  {terminalInputStatus(terminalControls)}
                </Badge>
                <span class="text-muted-foreground">Workflow</span>
                <Badge variant="secondary">
                  {selectedWorkflowStatus?.state ?? "idle"}
                </Badge>
              </div>
              <Separator />
              <div class="flex flex-wrap gap-2">
                {#if terminalControls?.runtimeState === "stopped" || terminalControls?.runtimeState === "crashed"}
                  <Button
                    size="sm"
                    disabled={terminalControls.busy}
                    onclick={() => terminalControls?.start()}
                  >
                    {#if terminalControls.busy}<Spinner
                        data-icon="inline-start"
                      />{:else}<HugeiconsIcon
                        icon={PlayIcon}
                        strokeWidth={2}
                        data-icon="inline-start"
                      />{/if}
                    {terminalControls.busy ? "Starting…" : "Start"}
                  </Button>
                {:else}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!terminalControls || terminalControls.busy}
                    onclick={() => terminalControls?.stop()}
                  >
                    {#if terminalControls?.busy}<Spinner
                        data-icon="inline-start"
                      />{:else}<HugeiconsIcon
                        icon={StopIcon}
                        strokeWidth={2}
                        data-icon="inline-start"
                      />{/if}
                    {terminalControls?.busy ? "Stopping…" : "Stop"}
                  </Button>
                {/if}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!terminalControls || terminalControls.busy}
                  onclick={() => terminalControls?.restart()}
                >
                  <HugeiconsIcon
                    icon={ArrowReloadHorizontalIcon}
                    strokeWidth={2}
                    data-icon="inline-start"
                  />
                  Restart
                </Button>
                {#if selectedWorkflowStatus?.state === "done" && selectedWorktreeId}
                  <Button
                    variant="secondary"
                    size="sm"
                    onclick={() =>
                      acknowledgeWorkflow(selectedWorktreeId!, true)}
                  >
                    <HugeiconsIcon
                      icon={CheckmarkCircle02Icon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />
                    Acknowledge done
                  </Button>
                {/if}
              </div>
            </div>
          </Popover.Content>
        </Popover.Root>
      {/if}
      <Badge
        variant={startup.status === "ready"
          ? "secondary"
          : startup.status === "connecting"
            ? "outline"
            : "destructive"}
        role="status"
        aria-label="Daemon connection"
        aria-live="polite"
        aria-atomic="true"
      >
        {startup.status === "connecting" ? "Connecting" : startup.message}
      </Badge>
    </div>
  </header>

  <Sidebar.Provider
    class="min-h-0"
    style="--sidebar-width: 16.5rem; --sidebar-width-mobile: 18rem;"
  >
    <Sidebar.Root
      collapsible="offcanvas"
      class="top-13 h-[calc(100dvh-3.25rem)]"
    >
      <Sidebar.Header>
        <div class="flex items-center justify-between">
          <WorkspaceSidebarAddButton
            disabled={startup.status !== "ready"}
            onAdd={() => (showAdd = true)}
          />
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group class="p-0">
          <Sidebar.GroupContent>
            <WorkspaceSidebar
              workspaces={$workspaceStore.workspaces}
              status={$workspaceStore.status}
              message={$workspaceStore.message}
              {selectedId}
              {selectedWorktreeId}
              worktreesByWorkspace={$worktreeStore.byWorkspace}
              worktreeLoadingByWorkspace={$worktreeStore.loadingByWorkspace}
              worktreeErrorsByWorkspace={$worktreeStore.errorsByWorkspace}
              workflowStatuses={$workflowStatusStore.byWorktree}
              diffSummaries={sidebarDiffSummaries}
              workspaceAttentionStatuses={$workflowStatusStore.workspaceAttention}
              statusChannel={$workflowStatusStore.channel}
              onSelect={selectWorkspace}
              onExpand={loadWorkspaceWorktrees}
              onVisibleWorktreesChange={trackVisibleDiffWorktrees}
              onCreateWorktree={openCreateWorktree}
              onSelectWorktree={selectWorktree}
            />
          </Sidebar.GroupContent>
        </Sidebar.Group>
      </Sidebar.Content>
      <Sidebar.Rail />
    </Sidebar.Root>

    <Sidebar.Inset class="min-h-0 min-w-0 overflow-hidden">
      {#if startup.status === "disconnected" || startup.status === "migration-failed"}
        <Alert.Root
          variant="destructive"
          class="rounded-none border-x-0 border-t-0"
          role="alert"
          aria-live="assertive"
        >
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <Alert.Title
            >{startup.status === "migration-failed"
              ? "Database setup failed"
              : "Daemon disconnected"}</Alert.Title
          >
          <Alert.Description
            >{startup.message}. Check the daemon output for an actionable
            diagnostic.</Alert.Description
          >
          <Alert.Action>
            <Button variant="outline" size="sm" onclick={connect}
              >Try again</Button
            >
          </Alert.Action>
        </Alert.Root>
      {/if}

      <Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
        <Resizable.Pane class="flex min-h-0" minSize={30} order={1}>
          <div
            id="main-content"
            bind:this={mainContent}
            tabindex="-1"
            data-testid="dashboard-shell"
            class={cn(
              "relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-background",
              terminalOpen ? "overflow-hidden p-0" : "p-6 md:p-10 lg:p-12",
            )}
          >
            <div class="absolute left-4 top-4 z-10 md:hidden">
              <Sidebar.Trigger />
            </div>
            <LazyTerminalWorkspace
              selected={terminalOpen ? selectedWorktree : undefined}
              workspaceName={selectedWorkspace?.name ?? ""}
              cacheSize={terminalCacheSize}
              maxFrameBytes={terminalMaxFrameBytes}
              {liveTerminalWorktreeIds}
              onControlsChange={handleTerminalControlsChange}
              onAcknowledge={acknowledgeWorkflow}
            />

            {#if workspaceActionError}
              <Alert.Root
                variant="destructive"
                class="absolute right-4 top-4 z-10 max-w-md"
                role="alert"
              >
                <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
                <Alert.Title>Unable to complete action</Alert.Title>
                <Alert.Description>{workspaceActionError}</Alert.Description>
                <Alert.Action>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Dismiss error"
                    onclick={() => (workspaceActionError = "")}
                  >
                    <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                  </Button>
                </Alert.Action>
              </Alert.Root>
            {/if}

            {#if terminalOpen}
              <!-- The terminal workspace above owns the entire main content area. -->
            {:else if startup.status === "unauthorized"}
              <Empty.Root class="mx-auto h-full max-w-lg">
                <Empty.Header>
                  <Empty.Media variant="icon"
                    ><HugeiconsIcon
                      icon={ExternalLinkIcon}
                      strokeWidth={2}
                    /></Empty.Media
                  >
                  <Empty.Title role="heading" aria-level={2}
                    >Open Pi Dash from its launch link</Empty.Title
                  >
                  <Empty.Description
                    >Return to the terminal running Pi Dash and open the
                    one-time URL it printed.</Empty.Description
                  >
                </Empty.Header>
              </Empty.Root>
            {:else if startup.status === "connecting"}
              <Empty.Root class="mx-auto h-full max-w-lg">
                <Empty.Header>
                  <Empty.Media variant="icon"><Spinner /></Empty.Media>
                  <Empty.Title role="heading" aria-level={2}
                    >Connecting to your local daemon</Empty.Title
                  >
                  <Empty.Description
                    >Pi Dash is checking its database and secure browser
                    session.</Empty.Description
                  >
                </Empty.Header>
              </Empty.Root>
            {:else if startup.status === "disconnected" || startup.status === "migration-failed"}
              <Empty.Root class="mx-auto h-full max-w-lg">
                <Empty.Header>
                  <Empty.Media variant="icon"
                    ><HugeiconsIcon
                      icon={AlertCircleIcon}
                      strokeWidth={2}
                    /></Empty.Media
                  >
                  <Empty.Title role="heading" aria-level={2}
                    >{startup.status === "migration-failed"
                      ? "Database setup failed"
                      : "The local daemon is disconnected"}</Empty.Title
                  >
                  <Empty.Description
                    >Use the diagnostic above to recover without changing
                    repository files.</Empty.Description
                  >
                </Empty.Header>
              </Empty.Root>
            {:else if selectedWorkspace}
              <section
                class="mx-auto flex w-full max-w-5xl flex-col gap-6"
                aria-labelledby="workspace-title"
              >
                <header
                  class="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"
                >
                  <div class="min-w-0">
                    <Badge variant="outline">Workspace</Badge>
                    <h2
                      id="workspace-title"
                      class="mt-3 text-2xl font-semibold tracking-tight"
                    >
                      {selectedWorkspace.name}
                    </h2>
                    <p
                      class="mt-1 break-all font-mono text-sm text-muted-foreground"
                    >
                      {displayPath(selectedWorkspace.repositoryPath)}
                    </p>
                  </div>
                  <div class="flex gap-2">
                    <Button
                      variant="outline"
                      onclick={() => (renameTarget = selectedWorkspace)}
                    >
                      <HugeiconsIcon
                        icon={Edit02Icon}
                        strokeWidth={2}
                        data-icon="inline-start"
                      />Rename
                    </Button>
                    <Button
                      variant="destructive"
                      onclick={() => (removeTarget = selectedWorkspace)}
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        strokeWidth={2}
                        data-icon="inline-start"
                      />Remove
                    </Button>
                  </div>
                </header>

                <Card.Root>
                  <Card.Header>
                    <div>
                      <Card.Title
                        >{selectedWorkspace.repository.health === "healthy"
                          ? "Repository ready"
                          : "Repository needs attention"}</Card.Title
                      >
                      <Card.Description
                        >Repository health and recorded workspace details.</Card.Description
                      >
                    </div>
                    <Card.Action>
                      <Badge
                        variant={selectedWorkspace.repository.health ===
                        "healthy"
                          ? "secondary"
                          : "destructive"}
                      >
                        {selectedWorkspace.repository.health.replace("_", " ")}
                      </Badge>
                    </Card.Action>
                  </Card.Header>
                  <Card.Content>
                    <dl class="grid gap-4 sm:grid-cols-2">
                      <div class="min-w-0">
                        <dt class="text-sm text-muted-foreground">Branch</dt>
                        <dd class="truncate text-sm font-medium">
                          {selectedWorkspace.repository.currentBranch ??
                            "Detached or unborn HEAD"}
                        </dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-sm text-muted-foreground">HEAD</dt>
                        <dd class="truncate font-mono text-sm">
                          {selectedWorkspace.repository.headCommit?.slice(
                            0,
                            12,
                          ) ?? "No commit"}
                        </dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-sm text-muted-foreground">Checked</dt>
                        <dd class="truncate text-sm">
                          {selectedWorkspace.repository.checkedAt
                            ? new Date(
                                selectedWorkspace.repository.checkedAt,
                              ).toLocaleString()
                            : "Not checked"}
                        </dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-sm text-muted-foreground">
                          Workspace slug
                        </dt>
                        <dd class="truncate font-mono text-sm">
                          {selectedWorkspace.slug}
                        </dd>
                      </div>
                    </dl>
                  </Card.Content>
                  {#if selectedWorkspace.repository.health !== "healthy"}
                    <Card.Footer
                      class="flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <p class="text-sm text-muted-foreground">
                        The record remains registered. Retry after restoring
                        access, or remove only its Pi Dash metadata.
                      </p>
                      <Button
                        disabled={refreshingId === selectedWorkspace.id}
                        onclick={() => refresh(selectedWorkspace)}
                      >
                        {#if refreshingId === selectedWorkspace.id}<Spinner
                            data-icon="inline-start"
                          />{:else}<HugeiconsIcon
                            icon={RefreshIcon}
                            strokeWidth={2}
                            data-icon="inline-start"
                          />{/if}
                        {refreshingId === selectedWorkspace.id
                          ? "Checking…"
                          : "Retry health check"}
                      </Button>
                    </Card.Footer>
                  {/if}
                </Card.Root>

                <Separator />
                <section
                  class="flex flex-col gap-4"
                  aria-labelledby="worktree-heading"
                >
                  <div
                    class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"
                  >
                    <div>
                      <h3 id="worktree-heading" class="text-lg font-semibold">
                        Isolated branches
                      </h3>
                      <p class="text-sm text-muted-foreground">
                        Managed worktrees
                      </p>
                    </div>
                    <div class="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={reconciling}
                        onclick={reconcileWorktrees}
                      >
                        {#if reconciling}<Spinner
                            data-icon="inline-start"
                          />{:else}<HugeiconsIcon
                            icon={ArrowReloadHorizontalIcon}
                            strokeWidth={2}
                            data-icon="inline-start"
                          />{/if}
                        {reconciling ? "Reconciling…" : "Reconcile"}
                      </Button>
                      <Button
                        disabled={selectedWorkspace.repository.health !==
                          "healthy"}
                        onclick={() => openCreateWorktree(selectedWorkspace)}
                      >
                        <HugeiconsIcon
                          icon={Add01Icon}
                          strokeWidth={2}
                          data-icon="inline-start"
                        />Create worktree
                      </Button>
                    </div>
                  </div>
                  {#if $worktreeStore.loadingByWorkspace[selectedWorkspace.id] && selectedWorktrees.length === 0}
                    <div
                      class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
                      role="status"
                    >
                      <Spinner aria-hidden="true" />Loading managed worktrees…
                    </div>
                  {:else if $worktreeStore.errorsByWorkspace[selectedWorkspace.id]}
                    <Alert.Root variant="destructive" role="alert"
                      ><HugeiconsIcon
                        icon={AlertCircleIcon}
                        strokeWidth={2}
                      /><Alert.Description
                        >{$worktreeStore.errorsByWorkspace[
                          selectedWorkspace.id
                        ]}</Alert.Description
                      ></Alert.Root
                    >
                  {:else if selectedWorktrees.length === 0}
                    <Empty.Root class="border">
                      <Empty.Header>
                        <Empty.Media variant="icon"
                          ><HugeiconsIcon
                            icon={GitBranchIcon}
                            strokeWidth={2}
                          /></Empty.Media
                        >
                        <Empty.Title role="heading" aria-level={3}
                          >No managed worktrees</Empty.Title
                        >
                        <Empty.Description
                          >Create an isolated branch and linked worktree from an
                          exact local commit.</Empty.Description
                        >
                      </Empty.Header>
                    </Empty.Root>
                  {:else}
                    <div class="grid gap-4 md:grid-cols-2">
                      {#each selectedWorktrees as worktree (worktree.id)}
                        <Card.Root
                          role="article"
                          aria-label={worktree.name}
                          data-testid="worktree-card"
                          data-worktree-id={worktree.id}
                        >
                          <Card.Header>
                            <div class="min-w-0">
                              <Card.Title>{worktree.name}</Card.Title>
                              <Card.Description
                                >{worktree.lifecycle}</Card.Description
                              >
                            </div>
                            <Card.Action
                              ><Badge
                                variant={worktree.health === "healthy"
                                  ? "secondary"
                                  : "destructive"}
                                >{worktree.health.replace("_", " ")}</Badge
                              ></Card.Action
                            >
                          </Card.Header>
                          <Card.Content class="flex flex-col gap-3">
                            <code class="truncate text-sm"
                              >{worktree.branchRef}</code
                            >
                            <p
                              data-testid="worktree-path"
                              class="break-all font-mono text-xs text-muted-foreground"
                            >
                              {displayPath(worktree.path)}
                            </p>
                            <dl class="grid grid-cols-2 gap-3">
                              <div>
                                <dt class="text-xs text-muted-foreground">
                                  Base
                                </dt>
                                <dd class="font-mono text-sm">
                                  {worktree.baseCommit.slice(0, 12)}
                                </dd>
                              </div>
                              <div>
                                <dt class="text-xs text-muted-foreground">
                                  Changes
                                </dt>
                                <dd class="text-sm">
                                  {worktree.dirty === true
                                    ? "Dirty"
                                    : worktree.dirty === false
                                      ? "Clean"
                                      : "Unknown"}
                                </dd>
                              </div>
                            </dl>
                            {#if worktree.lastError}
                              <Alert.Root variant="destructive" role="status"
                                ><HugeiconsIcon
                                  icon={AlertCircleIcon}
                                  strokeWidth={2}
                                /><Alert.Title
                                  >{worktree.lastError.code}</Alert.Title
                                ><Alert.Description
                                  >{worktree.lastError
                                    .message}</Alert.Description
                                ></Alert.Root
                              >
                            {/if}
                          </Card.Content>
                          <Card.Footer class="flex-wrap gap-2">
                            {#if worktree.lifecycle === "ready"}
                              <Button
                                disabled={!canOpenTerminal(worktree)}
                                title={canOpenTerminal(worktree)
                                  ? "Open Pi terminal"
                                  : "Terminal unavailable until this worktree is healthy"}
                                onclick={() => selectWorktree(worktree)}
                              >
                                <HugeiconsIcon
                                  icon={ComputerTerminal01Icon}
                                  strokeWidth={2}
                                  data-icon="inline-start"
                                />Open Pi
                              </Button>
                              <Button
                                variant="destructive"
                                class="ml-auto"
                                onclick={() =>
                                  (removeWorktreeTarget = worktree)}
                              >
                                <HugeiconsIcon
                                  icon={Delete02Icon}
                                  strokeWidth={2}
                                  data-icon="inline-start"
                                />Remove
                              </Button>
                            {:else if worktree.lifecycle === "removed"}
                              <Button
                                variant="destructive"
                                onclick={() => (deleteBranchTarget = worktree)}
                              >
                                <HugeiconsIcon
                                  icon={Delete02Icon}
                                  strokeWidth={2}
                                  data-icon="inline-start"
                                />Delete merged branch
                              </Button>
                            {:else}
                              <Button
                                variant="outline"
                                onclick={reconcileWorktrees}
                              >
                                <HugeiconsIcon
                                  icon={ArrowReloadHorizontalIcon}
                                  strokeWidth={2}
                                  data-icon="inline-start"
                                />Inspect and reconcile
                              </Button>
                            {/if}
                          </Card.Footer>
                        </Card.Root>
                      {/each}
                    </div>
                  {/if}
                </section>
              </section>
            {:else}
              <Empty.Root class="mx-auto h-full max-w-lg">
                <Empty.Header>
                  <Empty.Media variant="icon"
                    ><HugeiconsIcon
                      icon={FolderGitIcon}
                      strokeWidth={2}
                    /></Empty.Media
                  >
                  <Empty.Title role="heading" aria-level={2}
                    >{$workspaceStore.workspaces.length > 0
                      ? "Select a workspace"
                      : "Add a workspace to get started"}</Empty.Title
                  >
                  <Empty.Description>
                    {$workspaceStore.workspaces.length > 0
                      ? "Choose a workspace for repository details, or expand it to open a managed worktree terminal."
                      : "Register an existing Git repository. Pi Dash validates it without modifying repository contents."}
                  </Empty.Description>
                </Empty.Header>
                {#if $workspaceStore.workspaces.length === 0}
                  <Empty.Content
                    ><Button onclick={() => (showAdd = true)}
                      ><HugeiconsIcon
                        icon={Add01Icon}
                        strokeWidth={2}
                        data-icon="inline-start"
                      />Add workspace</Button
                    ></Empty.Content
                  >
                {/if}
              </Empty.Root>
            {/if}
          </div>
        </Resizable.Pane>
        {#if terminalOpen && $diffStore.open && selectedWorktree && !isMobile.current}
          <Resizable.Handle withHandle />
          <Resizable.Pane
            class="min-h-0"
            defaultSize={45}
            minSize={30}
            maxSize={70}
            order={2}
          >
            <DiffWorkspace
              worktree={selectedWorktree}
              state={$diffStore}
              onRefresh={diffStore.refresh}
              onClose={() => diffStore.setOpen(false)}
            />
          </Resizable.Pane>
        {/if}
      </Resizable.PaneGroup>

      {#if terminalOpen && selectedWorktree && isMobile.current}
        <Sheet.Root
          open={$diffStore.open}
          onOpenChange={(open) => diffStore.setOpen(open)}
        >
          <Sheet.Content
            side="right"
            showCloseButton={false}
            class="w-[calc(100%-1rem)] p-0"
          >
            <Sheet.Header class="sr-only">
              <Sheet.Title>Worktree changes</Sheet.Title>
              <Sheet.Description>
                Unified diff against the selected worktree branch’s newest
                commit.
              </Sheet.Description>
            </Sheet.Header>
            <DiffWorkspace
              worktree={selectedWorktree}
              state={$diffStore}
              onRefresh={diffStore.refresh}
              onClose={() => diffStore.setOpen(false)}
            />
          </Sheet.Content>
        </Sheet.Root>
      {/if}
    </Sidebar.Inset>
  </Sidebar.Provider>
</div>

{#if showAdd}
  <AddWorkspaceDialog
    nativeAvailable={nativeDialogAvailable}
    onClose={() => (showAdd = false)}
    onCreated={upsert}
    onExisting={focusExisting}
  />
{/if}
{#if renameTarget}
  <RenameWorkspaceDialog
    workspace={renameTarget}
    onClose={() => (renameTarget = undefined)}
    onRenamed={upsert}
  />
{/if}
{#if removeTarget}
  <RemoveWorkspaceDialog
    workspace={removeTarget}
    fallbackFocus={mainContent}
    onClose={() => (removeTarget = undefined)}
    onRemoved={removeWorkspace}
  />
{/if}
{#if createWorktreeTarget}
  <CreateWorktreeDialog
    workspace={createWorktreeTarget}
    onClose={() => (createWorktreeTarget = undefined)}
    onCreated={upsertWorktree}
  />
{/if}
{#if removeWorktreeTarget}
  <RemoveWorktreeDialog
    worktree={removeWorktreeTarget}
    fallbackFocus={mainContent}
    onClose={() => (removeWorktreeTarget = undefined)}
    onRemoved={upsertWorktree}
  />
{/if}
{#if deleteBranchTarget && selectedWorkspace}
  <DeleteBranchDialog
    workspace={selectedWorkspace}
    worktree={deleteBranchTarget}
    fallbackFocus={mainContent}
    onClose={() => (deleteBranchTarget = undefined)}
    onDeleted={removeWorktree}
  />
{/if}
