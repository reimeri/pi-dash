<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import { afterUpdate } from "svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { TerminalControlsChange } from "./controls.js";
  import { loadPiTerminalWorkspace } from "./module-loaders.js";

  export let selected: WorktreeDto | undefined;
  export let workspaceName = "";
  export let cacheSize = 3;
  export let maxFrameBytes = 64 * 1024;
  export let liveTerminalWorktreeIds: string[] = [];
  export let onControlsChange: TerminalControlsChange;
  export let onAcknowledge: (worktreeId: string) => void;

  let WorkspaceComponent:
    typeof import("./TerminalWorkspace.svelte").default | undefined;
  let loading = false;
  let loadError = "";

  function load(): void {
    if (!selected || WorkspaceComponent || loading) return;
    loading = true;
    loadError = "";
    void loadPiTerminalWorkspace()
      .then((module) => {
        WorkspaceComponent = module.default;
      })
      .catch(() => {
        loadError = "The Pi terminal interface could not be loaded.";
      })
      .finally(() => {
        loading = false;
      });
  }

  afterUpdate(() => {
    if (!loadError) load();
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
    {onAcknowledge}
  />
{:else if selected && loadError}
  <Alert.Root variant="destructive" class="m-4" role="alert">
    <Alert.Title>Unable to open Pi terminal</Alert.Title>
    <Alert.Description>{loadError}</Alert.Description>
    <Alert.Action>
      <Button variant="outline" size="sm" onclick={load}>Retry</Button>
    </Alert.Action>
  </Alert.Root>
{:else if selected}
  <section
    class="flex size-full min-h-0 items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
    aria-label="Pi terminal"
    role="status"
  >
    <Spinner data-icon="inline-start" />
    Loading terminal…
  </section>
{/if}
