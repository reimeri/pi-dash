<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import { afterUpdate } from "svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";

  export let worktree: WorktreeDto;
  export let workspaceName: string;
  export let maxFrameBytes: number;
  export let onClose: () => void;

  let WorkspaceComponent:
    typeof import("./ShellTerminalWorkspace.svelte").default | undefined;
  let loading = false;
  let loadError = "";

  function load(): void {
    if (WorkspaceComponent || loading) return;
    loading = true;
    loadError = "";
    void import("./ShellTerminalWorkspace.svelte")
      .then((module) => {
        WorkspaceComponent = module.default;
      })
      .catch(() => {
        loadError = "The shell terminal interface could not be loaded.";
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
  <WorkspaceComponent {worktree} {workspaceName} {maxFrameBytes} {onClose} />
{:else if loadError}
  <Alert.Root variant="destructive" class="m-4" role="alert">
    <Alert.Title>Unable to open terminal</Alert.Title>
    <Alert.Description>{loadError}</Alert.Description>
    <Alert.Action>
      <Button variant="outline" size="sm" onclick={load}>Retry</Button>
    </Alert.Action>
  </Alert.Root>
{/if}
