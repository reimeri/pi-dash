<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import TerminalPane from "./TerminalPane.svelte";

  export let selected: WorktreeDto | undefined;
  export let workspaceName = "";
  export let cacheSize = 3;
  export let maxFrameBytes = 64 * 1024;
  export let liveTerminalWorktreeIds: string[] = [];

  interface CacheEntry {
    worktree: WorktreeDto;
    workspaceName: string;
  }

  let entries: CacheEntry[] = [];

  function synchronizeCache(
    worktree: WorktreeDto | undefined,
    name: string,
    maximum: number,
    liveIds: string[],
  ): void {
    const live = new Set(liveIds);
    const retained = entries.filter((entry) => live.has(entry.worktree.id));
    entries = worktree
      ? [
          ...retained.filter((entry) => entry.worktree.id !== worktree.id),
          { worktree, workspaceName: name },
        ].slice(-maximum)
      : retained;
  }

  $: synchronizeCache(
    selected?.lifecycle === "ready" ? selected : undefined,
    workspaceName,
    cacheSize,
    liveTerminalWorktreeIds,
  );
</script>

{#if entries.length > 0}
  <section
    class:hidden={!selected}
    class="terminal-workspace"
    aria-label="Pi terminals"
  >
    {#each entries as entry (entry.worktree.id)}
      <TerminalPane
        worktree={entry.worktree}
        workspaceName={entry.workspaceName}
        visible={selected?.id === entry.worktree.id}
        {maxFrameBytes}
      />
    {/each}
  </section>
{/if}

<style>
  .terminal-workspace {
    min-height: 0;
  }

  .terminal-workspace.hidden {
    display: none;
  }
</style>
