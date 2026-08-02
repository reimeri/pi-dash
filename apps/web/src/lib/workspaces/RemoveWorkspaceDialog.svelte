<script lang="ts">
  import type { WorkspaceDto } from "@pi-dash/contracts";
  import { AlertCircleIcon, Delete02Icon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onMount } from "svelte";
  import * as Alert from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import * as Card from "$lib/components/ui/card";
  import { Spinner } from "$lib/components/ui/spinner";
  import { api } from "../../api.js";
  import { displayPath } from "./display.js";

  export let workspace: WorkspaceDto;
  export let fallbackFocus: HTMLElement | null = null;
  export let onClose: () => void;
  export let onRemoved: (id: string) => void;
  let removing = false;
  let error = "";
  let dialogOpen = true;
  let returnFocus: HTMLElement | null = null;

  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  });

  function restoreFocus(): void {
    requestAnimationFrame(() => {
      const target = returnFocus?.isConnected ? returnFocus : fallbackFocus;
      if (target?.isConnected) target.focus();
    });
  }

  function close() {
    if (removing) return;
    onClose();
    restoreFocus();
  }

  function finishClose(): void {
    onClose();
    restoreFocus();
  }
  async function remove() {
    removing = true;
    error = "";
    try {
      await api.removeWorkspace(workspace.id);
      onRemoved(workspace.id);
      finishClose();
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to remove the workspace.";
      removing = false;
    }
  }
</script>

<AlertDialog.Root bind:open={dialogOpen}>
  <AlertDialog.Content
    onEscapeKeydown={(event) => {
      event.preventDefault();
      if (!removing) close();
    }}
    onInteractOutside={(event) => {
      event.preventDefault();
      if (!removing) close();
    }}
  >
    <AlertDialog.Header>
      <AlertDialog.Media
        ><HugeiconsIcon
          icon={Delete02Icon}
          strokeWidth={2}
        /></AlertDialog.Media
      >
      <AlertDialog.Title>Remove workspace</AlertDialog.Title>
      <AlertDialog.Description
        >This removes Pi Dash metadata only. Repository files are never deleted.</AlertDialog.Description
      >
    </AlertDialog.Header>
    <Card.Root size="sm">
      <Card.Header>
        <Card.Title>{workspace.name}</Card.Title>
        <Card.Description class="break-all font-mono"
          >{displayPath(workspace.repositoryPath)}</Card.Description
        >
      </Card.Header>
    </Card.Root>
    {#if workspace.worktreeCount > 0}<Alert.Root
        variant="destructive"
        role="note"
        ><HugeiconsIcon
          icon={AlertCircleIcon}
          strokeWidth={2}
        /><Alert.Description
          >This workspace has {workspace.worktreeCount} managed {workspace.worktreeCount ===
          1
            ? "worktree"
            : "worktrees"}. Remove them first.</Alert.Description
        ></Alert.Root
      >{/if}
    {#if error}<Alert.Root variant="destructive" role="alert"
        ><HugeiconsIcon
          icon={AlertCircleIcon}
          strokeWidth={2}
        /><Alert.Description>{error}</Alert.Description></Alert.Root
      >{/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={removing} onclick={close}
        >Cancel</AlertDialog.Cancel
      >
      <AlertDialog.Action
        variant="destructive"
        disabled={removing || workspace.worktreeCount > 0}
        onclick={(event) => {
          event.preventDefault();
          void remove();
        }}
      >
        {#if removing}<Spinner data-icon="inline-start" />{:else}<HugeiconsIcon
            icon={Delete02Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />{/if}
        {removing ? "Removing…" : "Remove workspace"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
