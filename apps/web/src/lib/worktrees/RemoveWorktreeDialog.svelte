<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import { AlertCircleIcon, Delete02Icon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onMount } from "svelte";
  import * as Alert from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import * as Card from "$lib/components/ui/card";
  import { Spinner } from "$lib/components/ui/spinner";
  import { ApiClientError, api } from "../../api.js";

  export let worktree: WorktreeDto;
  export let fallbackFocus: HTMLElement | null = null;
  export let onClose: () => void;
  export let onRemoved: (worktree: WorktreeDto) => void;
  let removing = false;
  let error = "";
  let operationId = crypto.randomUUID();
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
      const response = await api.removeWorktree(worktree.id, operationId);
      onRemoved(response.worktree);
      finishClose();
    } catch (caught) {
      error =
        caught instanceof ApiClientError &&
        caught.envelope?.error.code === "WORKTREE_DIRTY"
          ? "Removal was refused because tracked or untracked changes are present. Commit, stash, or clean them outside Pi Dash, then reconcile and retry."
          : caught instanceof Error
            ? caught.message
            : "Unable to remove worktree.";
      if (caught instanceof ApiClientError) operationId = crypto.randomUUID();
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
    <p class="sr-only" role="status" aria-live="polite">
      {removing ? "Checking and removing managed worktree" : ""}
    </p>
    <AlertDialog.Header
      ><AlertDialog.Media
        ><HugeiconsIcon
          icon={Delete02Icon}
          strokeWidth={2}
        /></AlertDialog.Media
      ><AlertDialog.Title>Remove managed worktree</AlertDialog.Title
      ><AlertDialog.Description
        >Removal is clean-only. Pi Dash never forces deletion of changed files.</AlertDialog.Description
      ></AlertDialog.Header
    >
    <Card.Root size="sm">
      <Card.Header>
        <Card.Title>{worktree.name}</Card.Title>
        <Card.Description class="break-all font-mono"
          >{worktree.path}</Card.Description
        >
      </Card.Header>
    </Card.Root>
    <dl class="grid gap-3 text-sm">
      <div>
        <dt class="text-muted-foreground">Branch</dt>
        <dd><code>{worktree.branchRef}</code></dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Base</dt>
        <dd><code>{worktree.baseCommit.slice(0, 12)}</code></dd>
      </div>
      <div>
        <dt class="text-muted-foreground">Dirty state</dt>
        <dd>
          {worktree.dirty === false
            ? "Last check was clean"
            : worktree.dirty === true
              ? "Changes detected"
              : "Will be checked before removal"}
        </dd>
      </div>
    </dl>
    <p class="text-sm text-muted-foreground">
      This removes the linked worktree directory but keeps its Git branch.
      Branch deletion is a separate, mergedness-checked confirmation.
    </p>
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
        disabled={removing}
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
        {removing ? "Checking and removing…" : "Remove clean worktree"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
