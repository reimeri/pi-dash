<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import type { TerminalControls, TerminalControlsChange } from "./controls.js";
  import TerminalPane from "./TerminalPane.svelte";

  export let selected: WorktreeDto | undefined;
  export let workspaceName = "";
  export let cacheSize = 3;
  export let maxFrameBytes = 64 * 1024;
  export let liveTerminalWorktreeIds: string[] = [];
  export let onControlsChange: TerminalControlsChange;
  export let onAcknowledge: (worktreeId: string) => void;

  interface CacheEntry {
    worktree: WorktreeDto;
    workspaceName: string;
  }

  let entries: CacheEntry[] = [];
  let controlsSelectionId: string | undefined;

  function reportControls(
    worktreeId: string,
    controls: TerminalControls | undefined,
  ): void {
    if (selected?.id === worktreeId) onControlsChange(controls);
  }

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
  $: if (selected?.id !== controlsSelectionId) {
    controlsSelectionId = selected?.id;
    onControlsChange(undefined);
  }
</script>

{#if entries.length > 0}
  <section
    class:hidden={!selected}
    class="terminal-workspace size-full min-h-0"
    aria-label="Pi terminals"
  >
    {#each entries as entry (entry.worktree.id)}
      <TerminalPane
        worktree={entry.worktree}
        workspaceName={entry.workspaceName}
        visible={selected?.id === entry.worktree.id}
        {maxFrameBytes}
        onControlsChange={reportControls}
        {onAcknowledge}
      />
    {/each}
  </section>
{/if}
