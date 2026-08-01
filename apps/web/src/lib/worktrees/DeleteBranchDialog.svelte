<script lang="ts">
  import type {
    GitRefDto,
    WorkspaceDto,
    WorktreeDto,
  } from "@pi-dash/contracts";
  import { onMount } from "svelte";
  import { ApiClientError, api } from "../../api.js";
  import Modal from "../workspaces/Modal.svelte";

  export let workspace: WorkspaceDto;
  export let worktree: WorktreeDto;
  export let onClose: () => void;
  export let onDeleted: (worktree: WorktreeDto) => void;

  let safetyTarget: (GitRefDto & { ref: string }) | null = null;
  let loading = true;
  let deleting = false;
  let error = "";
  let operationId = crypto.randomUUID();

  async function loadTarget() {
    try {
      const response = await api.worktreeRefs(workspace.id);
      safetyTarget = response.head;
      if (!safetyTarget) error = "Workspace HEAD does not resolve to a commit.";
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to resolve workspace HEAD.";
    } finally {
      loading = false;
    }
  }

  async function removeBranch() {
    if (!safetyTarget || !worktree.finalBranchTip) return;
    deleting = true;
    error = "";
    try {
      const response = await api.deleteWorktreeBranch(
        worktree.id,
        {
          expectedBranchTip: worktree.finalBranchTip,
          safetyTargetCommit: safetyTarget.commit,
        },
        operationId,
      );
      onDeleted(response.worktree);
      onClose();
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        caught.envelope?.error.code === "BRANCH_NOT_MERGED"
      ) {
        error =
          "The branch is not merged into the displayed workspace HEAD. It was not deleted; the worktree remains removed.";
      } else {
        error =
          caught instanceof Error ? caught.message : "Unable to delete branch.";
      }
      if (caught instanceof ApiClientError) operationId = crypto.randomUUID();
      deleting = false;
    }
  }

  onMount(() => void loadTarget());
</script>

<Modal
  title="Delete removed worktree branch"
  description="This separately deletes only the unchanged recorded branch ref after proving it is merged."
  {onClose}
  closeOnEscape={!deleting}
  dismissable={!deleting}
>
  <p class="sr-only" role="status" aria-live="polite">
    {deleting ? "Verifying and deleting managed branch" : ""}
  </p>
  <div class="remove-summary">
    <strong>{worktree.name}</strong>
    <code>{worktree.branchRef}</code>
  </div>
  {#if loading}
    <div class="dialog-progress" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>Resolving workspace HEAD…</p>
    </div>
  {:else if safetyTarget}
    <dl class="confirmation-facts">
      <div>
        <dt>Expected branch tip</dt>
        <dd><code>{worktree.finalBranchTip}</code></dd>
      </div>
      <div>
        <dt>Safety target</dt>
        <dd><code>{safetyTarget.fullName} at {safetyTarget.commit}</code></dd>
      </div>
    </dl>
    <p class="field-help">
      Pi Dash verifies no worktree uses this branch, proves the expected tip is
      an ancestor of this exact target, then atomically compare-deletes the ref.
      A moved or unmerged branch is left intact.
    </p>
  {/if}
  {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  <div class="modal-actions">
    <button
      class="button secondary"
      type="button"
      disabled={deleting}
      on:click={onClose}>Keep branch</button
    >
    <button
      class="button danger"
      type="button"
      disabled={deleting || !safetyTarget}
      on:click={removeBranch}
    >
      {deleting ? "Verifying and deleting…" : "Delete merged branch"}
    </button>
  </div>
</Modal>
