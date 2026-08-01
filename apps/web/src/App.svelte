<script lang="ts">
  import { onMount } from "svelte";
  import { ApiClientError, api } from "./api.js";
  import {
    initialStartupState,
    reduceStartupState,
    type StartupState,
  } from "./connection.js";

  let startup: StartupState = initialStartupState;

  async function connect() {
    startup = reduceStartupState(startup, { type: "CONNECT" });
    try {
      const health = await api.health();
      if (health.status === "migration-failed") {
        startup = reduceStartupState(startup, { type: "MIGRATION_FAILED" });
        return;
      }
      await api.session();
      startup = reduceStartupState(startup, { type: "READY" });
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

  onMount(() => {
    void connect();
  });
</script>

<svelte:head>
  <title>Pi Dash</title>
</svelte:head>

<a class="skip-link" href="#main-content">Skip to main content</a>
<div class="app-frame">
  <header class="topbar">
    <div class="brand" aria-label="Pi Dash home">
      <span class="brand-mark" aria-hidden="true">π</span>
      <span>Pi Dash</span>
    </div>
    <div
      class={`connection connection-${startup.status}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span class="status-dot" aria-hidden="true"></span>
      <span>{startup.message}</span>
    </div>
  </header>

  {#if startup.status === "disconnected" || startup.status === "migration-failed"}
    <section class="global-error" role="alert" aria-live="assertive">
      <div>
        <strong>
          {startup.status === "migration-failed"
            ? "Database setup failed"
            : "Daemon disconnected"}
        </strong>
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
          disabled
          aria-label="Add workspace (available in Phase 2)"
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
      <nav aria-label="Workspaces">
        <div class="sidebar-empty">
          <span class="empty-icon" aria-hidden="true">⌂</span>
          <p>No workspaces yet</p>
          <span>Registered repositories will appear here.</span>
        </div>
      </nav>
      <div class="sidebar-footer">
        <span class="local-indicator" aria-hidden="true"></span>
        Local only
      </div>
    </aside>

    <main id="main-content" tabindex="-1">
      <div class="empty-state">
        {#if startup.status === "unauthorized"}
          <span class="empty-state-icon" aria-hidden="true">↗</span>
          <p class="eyebrow">Authentication required</p>
          <h2>Open Pi Dash from its launch link</h2>
          <p>
            Return to the terminal running Pi Dash and open the one-time URL it
            printed. The link expires quickly and can only be used once.
          </p>
        {:else if startup.status === "connecting"}
          <span class="spinner" aria-hidden="true"></span>
          <p class="eyebrow">Starting up</p>
          <h2>Connecting to your local daemon</h2>
          <p>Pi Dash is checking its database and secure browser session.</p>
        {:else if startup.status === "disconnected"}
          <span class="empty-state-icon" aria-hidden="true">×</span>
          <p class="eyebrow">Connection unavailable</p>
          <h2>The local daemon is disconnected</h2>
          <p>
            Restart Pi Dash or use the error banner to try the connection again.
          </p>
        {:else if startup.status === "migration-failed"}
          <span class="empty-state-icon" aria-hidden="true">!</span>
          <p class="eyebrow">Database unavailable</p>
          <h2>Pi Dash could not finish database setup</h2>
          <p>
            Review the daemon diagnostic and restore a verified backup if
            instructed.
          </p>
        {:else}
          <span class="empty-state-icon" aria-hidden="true">⌁</span>
          <p class="eyebrow">Dashboard ready</p>
          <h2>Add a workspace to get started</h2>
          <p>
            Workspace registration arrives in the next phase. This foundation is
            connected, authenticated, and ready for local projects.
          </p>
        {/if}
      </div>
    </main>
  </div>
</div>
