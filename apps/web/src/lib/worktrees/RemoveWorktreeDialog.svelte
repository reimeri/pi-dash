<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import { ApiClientError, api } from "../../api.js";
  import Modal from "../workspaces/Modal.svelte";

  export let worktree: WorktreeDto;
  export let onClose: () => void;
  export let onRemoved: (worktree: WorktreeDto) => void;

  let removing = false;
  let error = "";
  let operationId = crypto.randomUUID();

  async function remove() {
    removing = true;
    error = "";
    try {
      const response = await api.removeWorktree(worktree.id, operationId);
      onRemoved(response.worktree);
      onClose();
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        caught.envelope?.error.code === "WORKTREE_DIRTY"
      ) {
        error =
          "Removal was refused because tracked or untracked changes are present. Commit, stash, or clean them outside Pi Dash, then reconcile and retry.";
      } else {
        error =
          caught instanceof Error
            ? caught.message
            : "Unable to remove worktree.";
      }
      if (caught instanceof ApiClientError) operationId = crypto.randomUUID();
      removing = false;
    }
  }
</script>

<Modal
  title="Remove managed worktree"
  description="Removal is clean-only. Pi Dash never forces deletion of changed files."
  {onClose}
  closeOnEscape={!removing}
  dismissable={!removing}
>
  <p class="sr-only" role="status" aria-live="polite">
    {removing ? "Checking and removing managed worktree" : ""}
  </p>
  <div class="remove-summary">
    <strong>{worktree.name}</strong>
    <code>{worktree.path}</code>
  </div>
  <dl class="confirmation-facts">
    <div>
      <dt>Branch</dt>
      <dd><code>{worktree.branchRef}</code></dd>
    </div>
    <div>
      <dt>Base</dt>
      <dd><code>{worktree.baseCommit.slice(0, 12)}</code></dd>
    </div>
    <div>
      <dt>Dirty state</dt>
      <dd>
        {worktree.dirty === false
          ? "Last check was clean"
          : worktree.dirty === true
            ? "Changes detected"
            : "Will be checked before removal"}
      </dd>
    </div>
  </dl>
  <p class="field-help">
    This removes the linked worktree directory but keeps its Git branch. Branch
    deletion is a separate, mergedness-checked confirmation.
  </p>
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
      disabled={removing}
      on:click={remove}
    >
      {removing ? "Checking and removing…" : "Remove clean worktree"}
    </button>
  </div>
</Modal>
