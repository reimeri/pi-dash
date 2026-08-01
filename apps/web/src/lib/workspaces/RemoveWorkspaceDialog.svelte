<script lang="ts">
  import type { WorkspaceDto } from "@pi-dash/contracts";
  import { api } from "../../api.js";
  import Modal from "./Modal.svelte";
  import { displayPath } from "./display.js";

  export let workspace: WorkspaceDto;
  export let onClose: () => void;
  export let onRemoved: (id: string) => void;

  let removing = false;
  let error = "";

  async function remove() {
    removing = true;
    error = "";
    try {
      await api.removeWorkspace(workspace.id);
      onRemoved(workspace.id);
      onClose();
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to remove the workspace.";
      removing = false;
    }
  }
</script>

<Modal
  title="Remove workspace"
  description="This removes Pi Dash metadata only. Repository files are never deleted."
  {onClose}
  closeOnEscape={!removing}
  dismissable={!removing}
>
  <div class="remove-summary">
    <strong>{workspace.name}</strong>
    <code>{displayPath(workspace.repositoryPath)}</code>
  </div>
  {#if workspace.worktreeCount > 0}
    <p class="field-error" role="alert">
      This workspace has {workspace.worktreeCount} managed {workspace.worktreeCount ===
      1
        ? "worktree"
        : "worktrees"}. Remove them first.
    </p>
  {/if}
  {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  <div class="modal-actions">
    <button
      class="button secondary"
      type="button"
      disabled={removing}
      on:click={onClose}>Cancel</button
    >
    <button
      class="button danger"
      type="button"
      disabled={removing || workspace.worktreeCount > 0}
      on:click={remove}
    >
      {removing ? "Removing…" : "Remove workspace"}
    </button>
  </div>
</Modal>
