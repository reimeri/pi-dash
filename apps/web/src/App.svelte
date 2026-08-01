<script lang="ts">
  import type { WorkspaceDto, WorktreeDto } from "@pi-dash/contracts";
  import { onDestroy, onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { ApiClientError, api } from "./api.js";
  import {
    initialStartupState,
    reduceStartupState,
    type StartupState,
  } from "./connection.js";
  import AddWorkspaceDialog from "./lib/workspaces/AddWorkspaceDialog.svelte";
  import RemoveWorkspaceDialog from "./lib/workspaces/RemoveWorkspaceDialog.svelte";
  import RenameWorkspaceDialog from "./lib/workspaces/RenameWorkspaceDialog.svelte";
  import WorkspaceSidebar from "./lib/workspaces/WorkspaceSidebar.svelte";
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
  let showCreateWorktree = false;
  let removeWorktreeTarget: WorktreeDto | undefined;
  let deleteBranchTarget: WorktreeDto | undefined;
  let terminalControls: TerminalControls | undefined;
  let terminalMenuOpen = false;
  let terminalMenu: HTMLDivElement;
  let terminalMenuTrigger: HTMLButtonElement;
  let reconciling = false;
  let statusEvents: StatusEventClient | undefined;
  const acknowledgements = new SvelteMap<string, number>();
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
  $: selectedWorkflowStatus = selectedWorktreeId
    ? $workflowStatusStore.byWorktree[selectedWorktreeId]
    : undefined;
  $: terminalOpen =
    startup.status === "ready" &&
    !!selectedWorktree &&
    canOpenTerminal(selectedWorktree);
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
      statusEvents ??= createStatusEventClient();
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

  function handleWindowPointerdown(event: PointerEvent): void {
    if (
      terminalMenuOpen &&
      event.target instanceof Node &&
      !terminalMenu?.contains(event.target)
    ) {
      terminalMenuOpen = false;
    }
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !terminalMenuOpen) return;
    terminalMenuOpen = false;
    requestAnimationFrame(() => terminalMenuTrigger?.focus());
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

  onDestroy(() => statusEvents?.close());
</script>

<svelte:head><title>Pi Dash</title></svelte:head>
<svelte:window
  on:pointerdown={handleWindowPointerdown}
  on:keydown={handleWindowKeydown}
/>

<a class="skip-link" href="#main-content">Skip to main content</a>
<div class="app-frame">
  <header class="topbar">
    <div class="brand" aria-label="Pi Dash home">
      <span class="brand-mark" aria-hidden="true">π</span><span>Pi Dash</span>
    </div>
    <div class="topbar-statuses">
      {#if terminalOpen}
        <div class="terminal-menu" bind:this={terminalMenu}>
          <button
            class="terminal-menu-trigger"
            type="button"
            bind:this={terminalMenuTrigger}
            aria-expanded={terminalMenuOpen}
            aria-controls="terminal-controls"
            on:click={() => (terminalMenuOpen = !terminalMenuOpen)}
          >
            <span class="terminal-glyph" aria-hidden="true">›_</span>
            <span>Terminal</span>
            <span class="menu-chevron" aria-hidden="true"
              >{terminalMenuOpen ? "⌃" : "⌄"}</span
            >
          </button>
          {#if terminalMenuOpen}
            <section
              id="terminal-controls"
              class="terminal-menu-panel"
              aria-label="Terminal controls"
            >
              <div class="terminal-status-list" aria-live="polite">
                <div>
                  <span>Runtime</span>
                  <strong>
                    <span
                      class={`menu-status-dot runtime-${terminalControls?.runtimeState ?? "starting"}`}
                      aria-hidden="true"
                    ></span>
                    {terminalControls?.runtimeState ?? "starting"}
                  </strong>
                </div>
                <div>
                  <span>Socket</span>
                  <strong>
                    <span
                      class={`menu-status-dot socket-${terminalControls?.socketState ?? "connecting"}`}
                      aria-hidden="true"
                    ></span>
                    {terminalControls?.socketState ?? "connecting"}
                  </strong>
                </div>
                <div>
                  <span>Input</span>
                  <strong>{terminalInputStatus(terminalControls)}</strong>
                </div>
                <div>
                  <span>Workflow</span>
                  <strong>{selectedWorkflowStatus?.state ?? "idle"}</strong>
                </div>
              </div>
              <div class="terminal-menu-actions">
                <button
                  type="button"
                  disabled={!terminalControls}
                  on:click={() => terminalControls?.focus()}
                  >Focus terminal</button
                >
                {#if terminalControls?.runtimeState === "stopped" || terminalControls?.runtimeState === "crashed"}
                  <button
                    class="primary"
                    type="button"
                    disabled={terminalControls.busy}
                    on:click={() => terminalControls?.start()}
                    >{terminalControls.busy ? "Starting…" : "Start"}</button
                  >
                {:else}
                  <button
                    type="button"
                    disabled={!terminalControls || terminalControls.busy}
                    on:click={() => terminalControls?.stop()}
                    >{terminalControls?.busy ? "Stopping…" : "Stop"}</button
                  >
                {/if}
                <button
                  type="button"
                  disabled={!terminalControls || terminalControls.busy}
                  on:click={() => terminalControls?.restart()}>Restart</button
                >
                {#if selectedWorkflowStatus?.state === "done" && selectedWorktreeId}
                  <button
                    type="button"
                    on:click={() =>
                      acknowledgeWorkflow(selectedWorktreeId!, true)}
                    >Acknowledge done</button
                  >
                {/if}
              </div>
            </section>
          {/if}
        </div>
      {/if}
      <div
        class={`connection connection-${startup.status}`}
        role="status"
        aria-label="Daemon connection"
        aria-live="polite"
        aria-atomic="true"
      >
        <span class="status-dot" aria-hidden="true"></span><span
          >{startup.message}</span
        >
      </div>
    </div>
  </header>

  {#if startup.status === "disconnected" || startup.status === "migration-failed"}
    <section class="global-error" role="alert" aria-live="assertive">
      <div>
        <strong
          >{startup.status === "migration-failed"
            ? "Database setup failed"
            : "Daemon disconnected"}</strong
        >
        <p>
          {startup.message}. Check the daemon output for an actionable
          diagnostic.
        </p>
      </div>
      <button type="button" on:click={connect}>Try again</button>
    </section>
  {/if}

  <div class="dashboard">
    <aside class="sidebar" aria-labelledby="workspaces-heading">
      <div class="sidebar-heading">
        <div>
          <h1 id="workspaces-heading">Workspaces</h1>
        </div>
        <button
          class="icon-button"
          type="button"
          disabled={startup.status !== "ready"}
          aria-label="Add workspace"
          on:click={() => (showAdd = true)}
          ><span aria-hidden="true">+</span></button
        >
      </div>
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
        workspaceAttentionStatuses={$workflowStatusStore.workspaceAttention}
        statusChannel={$workflowStatusStore.channel}
        onSelect={selectWorkspace}
        onExpand={loadWorkspaceWorktrees}
        onSelectWorktree={selectWorktree}
      />
    </aside>

    <main id="main-content" class:terminal-open={terminalOpen} tabindex="-1">
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
        <div class="content-alert" role="alert">
          <span>{workspaceActionError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            on:click={() => (workspaceActionError = "")}>×</button
          >
        </div>
      {/if}

      {#if terminalOpen}
        <!-- The terminal workspace above owns the entire main content area. -->
      {:else if startup.status === "unauthorized"}
        <div class="empty-state">
          <span class="empty-state-icon" aria-hidden="true">↗</span>
          <p class="eyebrow">Authentication required</p>
          <h2>Open Pi Dash from its launch link</h2>
          <p>
            Return to the terminal running Pi Dash and open the one-time URL it
            printed.
          </p>
        </div>
      {:else if startup.status === "connecting"}
        <div class="empty-state">
          <span class="spinner" aria-hidden="true"></span>
          <p class="eyebrow">Starting up</p>
          <h2>Connecting to your local daemon</h2>
          <p>Pi Dash is checking its database and secure browser session.</p>
        </div>
      {:else if startup.status === "disconnected" || startup.status === "migration-failed"}
        <div class="empty-state">
          <span class="empty-state-icon" aria-hidden="true">!</span>
          <p class="eyebrow">Unavailable</p>
          <h2>
            {startup.status === "migration-failed"
              ? "Database setup failed"
              : "The local daemon is disconnected"}
          </h2>
          <p>
            Use the diagnostic above to recover without changing repository
            files.
          </p>
        </div>
      {:else if selectedWorkspace}
        <section class="workspace-detail" aria-labelledby="workspace-title">
          <header class="detail-header">
            <div>
              <p class="eyebrow">Workspace</p>
              <h2 id="workspace-title">{selectedWorkspace.name}</h2>
              <p class="detail-path">
                {displayPath(selectedWorkspace.repositoryPath)}
              </p>
            </div>
            <div class="detail-actions">
              <button
                class="button secondary"
                type="button"
                on:click={() => (renameTarget = selectedWorkspace)}
                >Rename</button
              >
              <button
                class="button secondary"
                type="button"
                on:click={() => (removeTarget = selectedWorkspace)}
                >Remove</button
              >
            </div>
          </header>
          <div
            class={`repository-card health-border-${selectedWorkspace.repository.health}`}
          >
            <div class="repository-card-heading">
              <div>
                <p class="eyebrow">Repository health</p>
                <h3>
                  {selectedWorkspace.repository.health === "healthy"
                    ? "Repository ready"
                    : "Repository needs attention"}
                </h3>
              </div>
              <span
                class={`health-badge health-${selectedWorkspace.repository.health}`}
                >{selectedWorkspace.repository.health.replace("_", " ")}</span
              >
            </div>
            <dl class="repository-facts">
              <div>
                <dt>Branch</dt>
                <dd>
                  {selectedWorkspace.repository.currentBranch ??
                    "Detached or unborn HEAD"}
                </dd>
              </div>
              <div>
                <dt>HEAD</dt>
                <dd>
                  <code
                    >{selectedWorkspace.repository.headCommit?.slice(0, 12) ??
                      "No commit"}</code
                  >
                </dd>
              </div>
              <div>
                <dt>Checked</dt>
                <dd>
                  {selectedWorkspace.repository.checkedAt
                    ? new Date(
                        selectedWorkspace.repository.checkedAt,
                      ).toLocaleString()
                    : "Not checked"}
                </dd>
              </div>
              <div>
                <dt>Workspace slug</dt>
                <dd><code>{selectedWorkspace.slug}</code></dd>
              </div>
            </dl>
            {#if selectedWorkspace.repository.health !== "healthy"}
              <div class="repair-row">
                <p>
                  The record remains registered. Retry after restoring access,
                  or remove only its Pi Dash metadata.
                </p>
                <button
                  class="button primary"
                  type="button"
                  disabled={refreshingId === selectedWorkspace.id}
                  on:click={() => refresh(selectedWorkspace)}
                >
                  {refreshingId === selectedWorkspace.id
                    ? "Checking…"
                    : "Retry health check"}
                </button>
              </div>
            {/if}
          </div>
          <section class="worktree-section" aria-labelledby="worktree-heading">
            <div class="section-heading">
              <div>
                <p class="eyebrow">Managed worktrees</p>
                <h3 id="worktree-heading">Isolated branches</h3>
              </div>
              <div class="detail-actions">
                <button
                  class="button secondary"
                  type="button"
                  disabled={reconciling}
                  on:click={reconcileWorktrees}
                  >{reconciling ? "Reconciling…" : "Reconcile"}</button
                >
                <button
                  class="button primary"
                  type="button"
                  disabled={selectedWorkspace.repository.health !== "healthy"}
                  on:click={() => (showCreateWorktree = true)}
                  >Create worktree</button
                >
              </div>
            </div>
            {#if $worktreeStore.loadingByWorkspace[selectedWorkspace.id] && selectedWorktrees.length === 0}
              <div class="dialog-progress" role="status">
                <span class="spinner" aria-hidden="true"></span>
                <p>Loading managed worktrees…</p>
              </div>
            {:else if $worktreeStore.errorsByWorkspace[selectedWorkspace.id]}
              <p class="field-error" role="alert">
                {$worktreeStore.errorsByWorkspace[selectedWorkspace.id]}
              </p>
            {:else if selectedWorktrees.length === 0}
              <div class="phase-placeholder">
                <h3>No managed worktrees</h3>
                <p>
                  Create an isolated branch and linked worktree from an exact
                  local commit.
                </p>
              </div>
            {:else}
              <div class="worktree-grid">
                {#each selectedWorktrees as worktree (worktree.id)}
                  <article
                    class:selected={selectedWorktreeId === worktree.id}
                    class="worktree-card"
                  >
                    <div class="worktree-card-heading">
                      <div>
                        <p class="eyebrow">{worktree.lifecycle}</p>
                        <h4>{worktree.name}</h4>
                      </div>
                      <span class={`health-badge health-${worktree.health}`}
                        >{worktree.health.replace("_", " ")}</span
                      >
                    </div>
                    <code class="branch-line">{worktree.branchRef}</code>
                    <p class="detail-path">{displayPath(worktree.path)}</p>
                    <dl class="repository-facts compact-facts">
                      <div>
                        <dt>Base</dt>
                        <dd>
                          <code>{worktree.baseCommit.slice(0, 12)}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Changes</dt>
                        <dd>
                          {worktree.dirty === true
                            ? "Dirty"
                            : worktree.dirty === false
                              ? "Clean"
                              : "Unknown"}
                        </dd>
                      </div>
                    </dl>
                    {#if worktree.lastError}
                      <p class="worktree-warning" role="status">
                        <strong>{worktree.lastError.code}</strong> — {worktree
                          .lastError.message}
                      </p>
                    {/if}
                    <div class="detail-actions worktree-actions">
                      {#if worktree.lifecycle === "ready"}
                        <button
                          class="button primary"
                          type="button"
                          disabled={!canOpenTerminal(worktree)}
                          title={canOpenTerminal(worktree)
                            ? "Open Pi terminal"
                            : "Terminal unavailable until this worktree is healthy"}
                          on:click={() => selectWorktree(worktree)}
                          >Open Pi terminal</button
                        >
                        <button
                          class="button danger"
                          type="button"
                          on:click={() => (removeWorktreeTarget = worktree)}
                          >Remove clean worktree</button
                        >
                      {:else if worktree.lifecycle === "removed" && !worktree.branchDeleted}
                        <button
                          class="button danger"
                          type="button"
                          on:click={() => (deleteBranchTarget = worktree)}
                          >Delete merged branch</button
                        >
                      {:else if worktree.lifecycle === "removed" && worktree.branchDeleted}
                        <span class="muted-label">Branch deleted safely</span>
                      {:else}
                        <button
                          class="button secondary"
                          type="button"
                          on:click={reconcileWorktrees}
                          >Inspect and reconcile</button
                        >
                      {/if}
                    </div>
                  </article>
                {/each}
              </div>
            {/if}
          </section>
        </section>
      {:else}
        <div class="empty-state">
          <span class="empty-state-icon" aria-hidden="true">⌁</span>
          <p class="eyebrow">Dashboard ready</p>
          {#if $workspaceStore.workspaces.length > 0}
            <h2>Select a workspace</h2>
            <p>
              Choose a workspace card for repository details, or expand it to
              open a managed worktree terminal.
            </p>
          {:else}
            <h2>Add a workspace to get started</h2>
            <p>
              Register an existing Git repository. Pi Dash canonicalizes and
              validates it without modifying repository contents.
            </p>
            <button
              class="button primary empty-action"
              type="button"
              on:click={() => (showAdd = true)}>Add workspace</button
            >
          {/if}
        </div>
      {/if}
    </main>
  </div>
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
    onClose={() => (removeTarget = undefined)}
    onRemoved={removeWorkspace}
  />
{/if}
{#if showCreateWorktree && selectedWorkspace}
  <CreateWorktreeDialog
    workspace={selectedWorkspace}
    onClose={() => (showCreateWorktree = false)}
    onCreated={upsertWorktree}
  />
{/if}
{#if removeWorktreeTarget}
  <RemoveWorktreeDialog
    worktree={removeWorktreeTarget}
    onClose={() => (removeWorktreeTarget = undefined)}
    onRemoved={upsertWorktree}
  />
{/if}
{#if deleteBranchTarget && selectedWorkspace}
  <DeleteBranchDialog
    workspace={selectedWorkspace}
    worktree={deleteBranchTarget}
    onClose={() => (deleteBranchTarget = undefined)}
    onDeleted={upsertWorktree}
  />
{/if}
