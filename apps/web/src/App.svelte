<script lang="ts">
  import type { WorkspaceDto } from "@pi-dash/contracts";
  import { onMount } from "svelte";
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

  let startup: StartupState = initialStartupState;
  let nativeDialogAvailable = false;
  let showAdd = false;
  let renameTarget: WorkspaceDto | undefined;
  let removeTarget: WorkspaceDto | undefined;
  let selectedId: string | undefined;
  let workspaceActionError = "";
  let refreshingId: string | undefined;
  $: selectedWorkspace = $workspaceStore.workspaces.find(
    (workspace) => workspace.id === selectedId,
  );

  async function connect() {
    startup = reduceStartupState(startup, { type: "CONNECT" });
    try {
      const health = await api.health();
      nativeDialogAvailable =
        health.capabilities.nativeDirectoryDialog === "available";
      if (health.status === "migration-failed") {
        startup = reduceStartupState(startup, { type: "MIGRATION_FAILED" });
        return;
      }
      await api.session();
      await workspaceStore.load();
      startup = reduceStartupState(startup, { type: "READY" });
      if (!selectedId && $workspaceStore.workspaces[0]) {
        selectedId = $workspaceStore.workspaces[0].id;
      }
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
      selectedId = $workspaceStore.workspaces[0]?.id;
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
    selectedId = id;
    showAdd = false;
  }

  onMount(() => {
    void connect();
  });
</script>

<svelte:head><title>Pi Dash</title></svelte:head>

<a class="skip-link" href="#main-content">Skip to main content</a>
<div class="app-frame">
  <header class="topbar">
    <div class="brand" aria-label="Pi Dash home">
      <span class="brand-mark" aria-hidden="true">π</span><span>Pi Dash</span>
    </div>
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
          <p class="eyebrow">Local projects</p>
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
        onSelect={(id) => (selectedId = id)}
        onRename={(workspace) => (renameTarget = workspace)}
        onRemove={(workspace) => (removeTarget = workspace)}
        onRetry={refresh}
      />
      <div class="sidebar-footer">
        <span class="local-indicator" aria-hidden="true"></span>Local only
      </div>
    </aside>

    <main id="main-content" tabindex="-1">
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

      {#if startup.status === "unauthorized"}
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
          <div class="phase-placeholder">
            <p class="eyebrow">Managed worktrees</p>
            <h3>No managed worktrees</h3>
            <p>Worktree management will be available in Phase 3.</p>
          </div>
        </section>
      {:else}
        <div class="empty-state">
          <span class="empty-state-icon" aria-hidden="true">⌁</span>
          <p class="eyebrow">Dashboard ready</p>
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
