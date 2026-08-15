<script lang="ts">
  import {
    APP_VERSION,
    type WorkspaceDto,
    type WorktreeDto,
  } from "@pi-dash/contracts";
  import { onDestroy, onMount } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { toast } from "svelte-sonner";
  import { AlertCircleIcon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Resizable from "$lib/components/ui/resizable";
  import * as Sidebar from "$lib/components/ui/sidebar";
  import { Toaster } from "$lib/components/ui/sonner";
  import { ApiClientError, api } from "./api.js";
  import {
    createCoordinatedWorktreeDiffClient,
    createWorktreeDiffStore,
    createWorktreeDiffSummaryStore,
    syncSidebarDiffSummaries,
  } from "./lib/diff/store.js";
  import { desktopBridge } from "./lib/desktop-bridge.js";
  import { IsMobile } from "./lib/hooks/is-mobile.svelte.js";
  import {
    initialStartupState,
    reduceStartupState,
    type StartupState,
  } from "./connection.js";
  import DashboardDialogs from "./lib/dashboard/DashboardDialogs.svelte";
  import DashboardHeader from "./lib/dashboard/DashboardHeader.svelte";
  import DashboardMain from "./lib/dashboard/DashboardMain.svelte";
  import RightPanelHost from "./lib/dashboard/RightPanelHost.svelte";
  import StartupEmptyStates from "./lib/dashboard/StartupEmptyStates.svelte";
  import { getStatusString } from "./lib/dashboard/status-label.js";
  import NoWorkspaceSelected from "./lib/workspaces/NoWorkspaceSelected.svelte";
  import EnvironmentRestartNotice from "./lib/workspaces/EnvironmentRestartNotice.svelte";
  import WorkspaceDetail from "./lib/workspaces/WorkspaceDetail.svelte";
  import WorkspaceSidebar from "./lib/workspaces/WorkspaceSidebar.svelte";
  import WorkspaceSidebarAddButton from "./lib/workspaces/WorkspaceSidebarAddButton.svelte";
  import { workspaceStore } from "./lib/workspaces/store.js";
  import type { TerminalControls } from "./lib/terminal/controls.js";
  import { scheduleTerminalModulePreload } from "./lib/terminal/module-loaders.js";
  import {
    createStatusEventClient,
    type StatusEventClient,
  } from "./lib/status/events.js";
  import { workflowStatusStore } from "./lib/status/store.js";
  import { canOpenTerminal } from "./lib/worktrees/terminal-access.js";
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
  let createWorktreeWorkspaceId: string | undefined;
  let removeWorktreeTarget: WorktreeDto | undefined;
  let deleteBranchTarget: WorktreeDto | undefined;
  type RightPanel = "none" | "diff" | "shell";
  let rightPanel: RightPanel = "none";
  let shellTrigger: HTMLButtonElement | null = null;
  let terminalControls: TerminalControls | undefined;
  let terminalMenuOpen = false;
  let focusTerminalAfterMenuClose = false;
  let mainContent: HTMLDivElement | null = null;
  let workspaceSidebar: WorkspaceSidebar | undefined;
  let reconciling = false;
  let environmentRefreshToken = 0;
  let restartingEnvironmentRuntimes = false;
  let statusEvents: StatusEventClient | undefined;
  const acknowledgements = new SvelteMap<string, number>();
  const syncingIds = new SvelteSet<string>();
  const diffClient = createCoordinatedWorktreeDiffClient(api);
  const diffStore = createWorktreeDiffStore(diffClient);
  const sidebarDiffSummaryStore = createWorktreeDiffSummaryStore(diffClient);
  const isMobile = new IsMobile();
  $: selectedWorkspace = $workspaceStore.workspaces.find(
    (workspace) => workspace.id === selectedId,
  );
  $: createWorktreeWorkspace = createWorktreeWorkspaceId
    ? $workspaceStore.workspaces.find(
        (workspace) => workspace.id === createWorktreeWorkspaceId,
      )
    : undefined;
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
  $: syncSidebarDiffSummaries(
    sidebarDiffSummaryStore,
    visibleDiffWorktreeIds,
    selectedWorktreeId,
    $diffStore.summary,
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
  $: shellCommandActive =
    !!selectedWorktreeId &&
    $workflowStatusStore.shellActivities[selectedWorktreeId]
      ?.foregroundCommandActive === true;
  $: shellActivityPending = shellCommandActive && rightPanel !== "shell";
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
    if (rightPanel !== "none") setRightPanel("none");
  }

  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 10_000;
  const RECONNECT_REQUEST_TIMEOUT_MS = 5_000;
  const RECOVERY_TOAST_ID = "daemon-recovery";
  let authRecoveryPromise: Promise<boolean> | undefined;
  let connectPromise: Promise<void> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  let destroyed = false;
  let cancelTerminalModulePreload: (() => void) | undefined;

  function cancelReconnect(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  function reconnectSignal(): AbortSignal {
    return AbortSignal.timeout(RECONNECT_REQUEST_TIMEOUT_MS);
  }

  function scheduleReconnect(immediate = false): void {
    if (
      destroyed ||
      reconnectTimer ||
      startup.status === "migration-failed" ||
      (startup.status === "unauthorized" && !desktopBridge())
    ) {
      return;
    }
    const delay = immediate
      ? 0
      : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void beginConnect(false);
    }, delay);
  }

  function disconnectAndRetry(): void {
    statusEvents?.close();
    statusEvents = undefined;
    startup = reduceStartupState(startup, { type: "DISCONNECTED" });
    scheduleReconnect();
  }

  function handleUnauthorized(): Promise<boolean> {
    statusEvents?.close();
    statusEvents = undefined;
    if (authRecoveryPromise) return authRecoveryPromise;
    const desktop = desktopBridge();
    startup = reduceStartupState(startup, { type: "CONNECT" });
    const pending = (
      desktop
        ? desktop.reauthenticate()
        : api.tailscaleSession(reconnectSignal())
    )
      .then(() => true)
      .catch((error) => {
        startup = reduceStartupState(startup, {
          type: "UNAUTHORIZED",
          message:
            !desktop && error instanceof ApiClientError && error.status === 403
              ? "This Tailscale identity is not authorized"
              : undefined,
        });
        if (desktop) scheduleReconnect();
        return false;
      })
      .finally(() => {
        if (authRecoveryPromise === pending) authRecoveryPromise = undefined;
      });
    authRecoveryPromise = pending;
    return pending;
  }

  async function connectOnce(showConnecting: boolean): Promise<void> {
    if (showConnecting) {
      startup = reduceStartupState(startup, { type: "CONNECT" });
    }
    try {
      const health = await api.health(reconnectSignal());
      nativeDialogAvailable =
        health.capabilities.nativeDirectoryDialog === "available";
      terminalCacheSize = health.settings.terminalCacheSize;
      terminalMaxFrameBytes = health.settings.terminalMaxFrameBytes;
      if (health.status === "migration-failed") {
        cancelReconnect();
        startup = reduceStartupState(startup, { type: "MIGRATION_FAILED" });
        return;
      }
      await api.session(reconnectSignal());
      statusEvents ??= createStatusEventClient({
        onWorktreeRemoved: removeWorktree,
        onWorkspaceUpdated: (workspace) => workspaceStore.upsert(workspace),
        onWorkspaceOrderUpdated: (workspaceIds) =>
          workspaceStore.applyOrder(workspaceIds),
        onWorkspaceEnvironmentChanged: (workspaceId) => {
          if (selectedId === workspaceId) environmentRefreshToken += 1;
        },
        onSnapshot: () => {
          void workspaceStore.load();
          for (const workspaceId of Object.keys($worktreeStore.byWorkspace)) {
            void worktreeStore.load(workspaceId);
          }
        },
        onAuthenticationRequired: () => {
          void handleUnauthorized().then((recovered) => {
            if (recovered) scheduleReconnect(true);
          });
        },
      });
      statusEvents.start();
      if (!(await workspaceStore.load(reconnectSignal()))) {
        throw new Error("Unable to load workspaces from the local daemon");
      }
      if (destroyed) return;
      reconnectAttempts = 0;
      startup = reduceStartupState(startup, { type: "READY" });
      cancelTerminalModulePreload ??= scheduleTerminalModulePreload();
      if (selectedId) {
        await worktreeStore.load(selectedId, reconnectSignal());
      }
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        if (await handleUnauthorized()) scheduleReconnect(true);
      } else if (
        error instanceof ApiClientError &&
        error.envelope?.error.code === "MIGRATION_REQUIRED"
      ) {
        cancelReconnect();
        startup = reduceStartupState(startup, {
          type: "MIGRATION_FAILED",
          message: error.message,
        });
      } else {
        disconnectAndRetry();
      }
    }
  }

  function beginConnect(showConnecting: boolean): Promise<void> {
    cancelReconnect();
    if (connectPromise) return connectPromise;
    const pending = connectOnce(showConnecting).finally(() => {
      if (connectPromise === pending) connectPromise = undefined;
    });
    connectPromise = pending;
    return pending;
  }

  function connect(): Promise<void> {
    return beginConnect(true);
  }

  let verifyingWake = false;
  async function verifySessionOnWake(): Promise<void> {
    if (verifyingWake) return;
    if (startup.status === "disconnected") {
      await connect();
      return;
    }
    if (startup.status !== "ready") return;
    verifyingWake = true;
    try {
      await api.health(reconnectSignal());
      await api.session(reconnectSignal());
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        if (await handleUnauthorized()) scheduleReconnect(true);
      } else {
        disconnectAndRetry();
      }
    } finally {
      verifyingWake = false;
    }
  }

  async function restartAffectedEnvironmentRuntimes(): Promise<boolean> {
    if (restartingEnvironmentRuntimes) return false;
    restartingEnvironmentRuntimes = true;
    workspaceActionError = "";
    const affected = workflowStatusStore
      .current()
      .environmentChanges.flatMap((change) => change.affectedRuntimes);
    const results = await Promise.allSettled(
      affected.map((runtime) =>
        runtime.kind === "pi"
          ? api.restartTerminal(
              runtime.worktreeId,
              crypto.randomUUID(),
              runtime.runtimeId,
            )
          : api.restartShellTerminal(
              runtime.worktreeId,
              crypto.randomUUID(),
              runtime.runtimeId,
            ),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      workspaceActionError =
        failure.reason instanceof Error
          ? failure.reason.message
          : "Unable to restart every affected runtime.";
    }
    restartingEnvironmentRuntimes = false;
    return !failure;
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

  async function refreshWorkspaceStatus(workspaceId: string): Promise<void> {
    refreshingId = workspaceId;
    try {
      const response = await api.refreshWorkspace(workspaceId);
      workspaceStore.upsert(response.workspace);
    } catch {
      // Automatic status refresh failures stay silent; manual refresh still surfaces errors.
    } finally {
      if (refreshingId === workspaceId) refreshingId = undefined;
    }
  }

  async function syncWorkspace(workspace: WorkspaceDto) {
    syncingIds.add(workspace.id);
    workspaceActionError = "";
    try {
      const response = await api.syncWorkspace(workspace.id);
      workspaceStore.upsert(response.workspace);
    } catch (error) {
      if (
        selectedId === workspace.id ||
        createWorktreeWorkspaceId === workspace.id
      ) {
        workspaceActionError =
          error instanceof Error ? error.message : "Unable to sync workspace.";
      }
    } finally {
      syncingIds.delete(workspace.id);
    }
  }

  function focusExisting(id: string) {
    selectWorkspace(id);
    showAdd = false;
  }

  function selectWorkspace(id: string) {
    setRightPanel("none");
    selectedId = id;
    selectedWorktreeId = undefined;
    void worktreeStore.load(id);
    void refreshWorkspaceStatus(id);
  }

  function loadWorkspaceWorktrees(id: string) {
    void worktreeStore.load(id);
  }

  function trackVisibleDiffWorktrees(ids: string[]): void {
    visibleDiffWorktreeIds = ids;
  }

  async function reorderWorkspaces(workspaceIds: string[]): Promise<void> {
    workspaceActionError = "";
    try {
      await workspaceStore.reorder(workspaceIds);
    } catch (error) {
      workspaceActionError =
        error instanceof Error
          ? error.message
          : "Unable to save workspace order.";
    }
  }

  function openCreateWorktree(workspace: WorkspaceDto) {
    createWorktreeWorkspaceId = workspace.id;
    void refreshWorkspaceStatus(workspace.id);
  }

  function selectWorktree(worktree: WorktreeDto) {
    if (!canOpenTerminal(worktree)) return;
    if (selectedWorktreeId !== worktree.id) setRightPanel("none");
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

  function setRightPanel(panel: RightPanel): void {
    rightPanel = panel;
    diffStore.setOpen(panel === "diff");
  }

  function toggleRightPanel(panel: Exclude<RightPanel, "none">): void {
    setRightPanel(rightPanel === panel ? "none" : panel);
  }

  function closeShellPanel(): void {
    setRightPanel("none");
    requestAnimationFrame(() => shellTrigger?.focus());
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

  function openCreatedWorktree(worktree: WorktreeDto): void {
    upsertWorktree(worktree);
    workspaceSidebar?.expandWorkspace(worktree.workspaceId);
    selectWorktree(worktree);
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
    const unsubscribeRecovery = desktopBridge()?.onRecoveryStatus((status) => {
      if (status === "retrying") {
        toast.loading("Reconnecting to the local daemon…", {
          id: RECOVERY_TOAST_ID,
          description:
            "Pi Dash will preserve active terminals while retrying for up to 15 seconds.",
        });
      } else if (status === "restarting") {
        toast.loading("Restarting the local daemon…", {
          id: RECOVERY_TOAST_ID,
          description: "The daemon did not recover during the retry window.",
        });
      } else {
        toast.success("Reconnected to the local daemon", {
          id: RECOVERY_TOAST_ID,
        });
      }
    });
    const onVisibility = () => {
      if (document.visibilityState === "visible") void verifySessionOnWake();
    };
    const onFocus = () => {
      void verifySessionOnWake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      unsubscribeRecovery?.();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  });

  onDestroy(() => {
    destroyed = true;
    cancelReconnect();
    cancelTerminalModulePreload?.();
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
<div
  class="grid h-dvh min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
>
  <DashboardHeader
    {diffAvailable}
    {terminalOpen}
    {rightPanel}
    diffState={$diffStore}
    {terminalControls}
    {selectedWorkflowStatus}
    {selectedWorktreeId}
    {shellActivityPending}
    bind:terminalMenuOpen
    bind:shellTrigger
    onTogglePanel={toggleRightPanel}
    onAcknowledge={acknowledgeWorkflow}
    onTerminalMenuCloseAutoFocus={handleTerminalMenuCloseAutoFocus}
  />

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
              bind:this={workspaceSidebar}
              workspaces={$workspaceStore.workspaces}
              status={$workspaceStore.status}
              message={$workspaceStore.message}
              {selectedId}
              {selectedWorktreeId}
              worktreesByWorkspace={$worktreeStore.byWorkspace}
              worktreeLoadingByWorkspace={$worktreeStore.loadingByWorkspace}
              worktreeErrorsByWorkspace={$worktreeStore.errorsByWorkspace}
              workflowStatuses={$workflowStatusStore.byWorktree}
              shellActivities={$workflowStatusStore.shellActivities}
              diffSummaries={sidebarDiffSummaries}
              workspaceAttentionStatuses={$workflowStatusStore.workspaceAttention}
              statusChannel={$workflowStatusStore.channel}
              onSelect={selectWorkspace}
              onExpand={loadWorkspaceWorktrees}
              onVisibleWorktreesChange={trackVisibleDiffWorktrees}
              reordering={$workspaceStore.reordering}
              onReorder={reorderWorkspaces}
              onCreateWorktree={openCreateWorktree}
              onSelectWorktree={selectWorktree}
            />
          </Sidebar.GroupContent>
        </Sidebar.Group>
      </Sidebar.Content>
      <Sidebar.Footer class="flex-row items-center justify-between">
        <Badge
          variant={startup.status === "ready"
            ? "default"
            : startup.status === "connecting"
              ? "outline"
              : "destructive"}
          role="status"
          aria-label="Daemon connection"
          aria-live="polite"
          aria-atomic="true"
          class="size-2 p-0"
          title={getStatusString(startup.status)}
        ></Badge>
        <span
          class="text-xs text-muted-foreground tabular-nums opacity-30"
          aria-label="Application version"
        >
          v{APP_VERSION}
        </span>
      </Sidebar.Footer>
      <Sidebar.Rail />
    </Sidebar.Root>

    <Sidebar.Inset class="min-h-0 min-w-0 overflow-hidden">
      {#if startup.status === "disconnected" || startup.status === "migration-failed" || startup.status === "unauthorized"}
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
              : startup.status === "unauthorized"
                ? "Authentication required"
                : "Daemon disconnected"}</Alert.Title
          >
          <Alert.Description>
            {startup.status === "unauthorized"
              ? `${startup.message}. Verify your local launch link or Tailscale access, then try again.`
              : `${startup.message}. Check the daemon output for an actionable diagnostic.`}
          </Alert.Description>
          <Alert.Action>
            <Button variant="outline" size="sm" onclick={connect}
              >Try again</Button
            >
          </Alert.Action>
        </Alert.Root>
      {/if}

      <EnvironmentRestartNotice
        changes={$workflowStatusStore.environmentChanges}
        workspaces={$workspaceStore.workspaces}
        worktreesByWorkspace={$worktreeStore.byWorkspace}
        shellActivities={$workflowStatusStore.shellActivities}
        restarting={restartingEnvironmentRuntimes}
        onRestart={restartAffectedEnvironmentRuntimes}
      />

      <Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
        <Resizable.Pane class="flex min-h-0" minSize={30} order={1}>
          <DashboardMain
            {terminalOpen}
            {selectedWorktree}
            workspaceName={selectedWorkspace?.name ?? ""}
            {terminalCacheSize}
            {terminalMaxFrameBytes}
            {liveTerminalWorktreeIds}
            {workspaceActionError}
            bind:mainContent
            onControlsChange={handleTerminalControlsChange}
            onAcknowledge={acknowledgeWorkflow}
            onDismissError={() => (workspaceActionError = "")}
          >
            {#if startup.status === "unauthorized" || startup.status === "connecting" || startup.status === "disconnected" || startup.status === "migration-failed"}
              <StartupEmptyStates {startup} />
            {:else if selectedWorkspace}
              <WorkspaceDetail
                workspace={selectedWorkspace}
                worktrees={selectedWorktrees}
                workflowStatuses={$workflowStatusStore.byWorktree}
                worktreeLoading={!!$worktreeStore.loadingByWorkspace[
                  selectedWorkspace.id
                ]}
                worktreeError={$worktreeStore.errorsByWorkspace[
                  selectedWorkspace.id
                ]}
                refreshing={refreshingId === selectedWorkspace.id}
                syncing={syncingIds.has(selectedWorkspace.id)}
                {reconciling}
                {environmentRefreshToken}
                onRename={() => (renameTarget = selectedWorkspace)}
                onRemove={() => (removeTarget = selectedWorkspace)}
                onSync={() => syncWorkspace(selectedWorkspace)}
                onRefresh={() => refresh(selectedWorkspace)}
                onReconcile={reconcileWorktrees}
                onCreateWorktree={() => openCreateWorktree(selectedWorkspace)}
                onOpenWorktree={selectWorktree}
                onRemoveWorktree={(worktree) =>
                  (removeWorktreeTarget = worktree)}
                onDeleteBranch={(worktree) => (deleteBranchTarget = worktree)}
              />
            {:else}
              <NoWorkspaceSelected
                hasWorkspaces={$workspaceStore.workspaces.length > 0}
                onAdd={() => (showAdd = true)}
              />
            {/if}
          </DashboardMain>
        </Resizable.Pane>
        {#if !isMobile.current}
          <RightPanelHost
            surface="desktop"
            {terminalOpen}
            {rightPanel}
            {selectedWorktree}
            workspaceName={selectedWorkspace?.name ?? ""}
            {terminalMaxFrameBytes}
            diffState={$diffStore}
            onRefreshDiff={diffStore.refresh}
            onCloseShell={closeShellPanel}
            onClosePanel={() => setRightPanel("none")}
          />
        {/if}
      </Resizable.PaneGroup>
      {#if isMobile.current}
        <RightPanelHost
          surface="mobile"
          {terminalOpen}
          {rightPanel}
          {selectedWorktree}
          workspaceName={selectedWorkspace?.name ?? ""}
          {terminalMaxFrameBytes}
          diffState={$diffStore}
          onRefreshDiff={diffStore.refresh}
          onCloseShell={closeShellPanel}
          onClosePanel={() => setRightPanel("none")}
        />
      {/if}
    </Sidebar.Inset>
  </Sidebar.Provider>
</div>

<DashboardDialogs
  {showAdd}
  {nativeDialogAvailable}
  {renameTarget}
  {removeTarget}
  {createWorktreeWorkspace}
  createWorktreeSyncing={!!createWorktreeWorkspace &&
    syncingIds.has(createWorktreeWorkspace.id)}
  {removeWorktreeTarget}
  {deleteBranchTarget}
  {selectedWorkspace}
  {mainContent}
  onCloseAdd={() => (showAdd = false)}
  onCreatedWorkspace={upsert}
  onExistingWorkspace={focusExisting}
  onCloseRename={() => (renameTarget = undefined)}
  onRenamedWorkspace={upsert}
  onCloseRemove={() => (removeTarget = undefined)}
  onRemovedWorkspace={removeWorkspace}
  onCloseCreateWorktree={() => (createWorktreeWorkspaceId = undefined)}
  onSyncCreateWorktree={() => {
    if (createWorktreeWorkspace) void syncWorkspace(createWorktreeWorkspace);
  }}
  onCreatedWorktree={openCreatedWorktree}
  onCloseRemoveWorktree={() => (removeWorktreeTarget = undefined)}
  onRemovedWorktree={(result) => {
    if (result.outcome === "removed_with_branch_cleanup") {
      upsertWorktree(result.worktree);
    } else {
      removeWorktree(result.workspaceId, result.worktreeId);
    }
  }}
  onCloseDeleteBranch={() => (deleteBranchTarget = undefined)}
  onDeletedBranch={removeWorktree}
/>

<Toaster />
