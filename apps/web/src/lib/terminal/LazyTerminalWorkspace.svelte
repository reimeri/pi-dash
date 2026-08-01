<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import { afterUpdate } from "svelte";
  import type { TerminalControlsChange } from "./controls.js";

  export let selected: WorktreeDto | undefined;
  export let workspaceName = "";
  export let cacheSize = 3;
  export let maxFrameBytes = 64 * 1024;
  export let liveTerminalWorktreeIds: string[] = [];
  export let onControlsChange: TerminalControlsChange;

  let WorkspaceComponent:
    typeof import("./TerminalWorkspace.svelte").default | undefined;
  let loading = false;

  afterUpdate(() => {
    if (!selected || WorkspaceComponent || loading) return;
    loading = true;
    void import("./TerminalWorkspace.svelte").then((module) => {
      WorkspaceComponent = module.default;
      loading = false;
    });
  });
</script>

{#if WorkspaceComponent}
  <WorkspaceComponent
    {selected}
    {workspaceName}
    {cacheSize}
    {maxFrameBytes}
    {liveTerminalWorktreeIds}
    {onControlsChange}
  />
{/if}
