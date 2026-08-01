<script lang="ts">
  import TerminalHost from "./TerminalHost.svelte";
  import type { AttentionState, RuntimeState } from "./protocol.js";

  let mounted = true;
  let connection: "connecting" | "connected" | "disconnected" = "connecting";
  let runtime: RuntimeState = "running";
  let exitCode: number | null = null;
  let attention: AttentionState = "idle";
  let statusCapability: "waiting" | "connected" | "degraded" = "waiting";
  let lastStatusEvent = "waiting for status extension";
  let error = "";

  function toggleTerminal(): void {
    mounted = !mounted;
  }
</script>

<svelte:head><title>Pi terminal feasibility spike</title></svelte:head>

<main>
  <header>
    <div>
      <p class="eyebrow">Phase 0 · disposable harness</p>
      <h1>Pi terminal bridge</h1>
      <p class="lede">One browser terminal attached to one PTY. Refreshing or unmounting this view does not stop the process.</p>
    </div>
    <button type="button" class="secondary" on:click={toggleTerminal} data-testid="toggle-terminal">
      {mounted ? "Unmount terminal" : "Mount terminal"}
    </button>
  </header>

  <section class="status-grid" aria-label="Bridge status" aria-live="polite">
    <div><span>Socket</span><strong data-testid="socket-state" class:ok={connection === "connected"}>{connection}</strong></div>
    <div><span>Process</span><strong>{runtime}{runtime === "exited" ? ` (${exitCode ?? "signal"})` : ""}</strong></div>
    <div><span>Attention</span><strong class:blocked={attention === "blocked"} class:done={attention === "done"}>{attention}</strong></div>
    <div><span>Status channel</span><strong data-testid="status-channel" class:ok={statusCapability === "connected"}>{statusCapability}</strong></div>
    <div><span>Last event</span><strong>{lastStatusEvent}</strong></div>
  </section>

  {#if error}
    <p class="notice" role="status">{error}</p>
  {/if}

  {#if mounted}
    <TerminalHost
      onConnection={(value) => (connection = value)}
      onRuntime={(state, code) => { runtime = state; exitCode = code; }}
      onAttention={(state, event, capability) => {
        attention = state;
        lastStatusEvent = event;
        statusCapability = capability;
      }}
      onError={(message) => (error = message)}
    />
  {:else}
    <section class="unmounted" data-testid="terminal-unmounted">
      <strong>Terminal presentation disposed</strong>
      <p>The PTY remains owned by the Fastify process. Mount again to request replay and redraw.</p>
    </section>
  {/if}
</main>
