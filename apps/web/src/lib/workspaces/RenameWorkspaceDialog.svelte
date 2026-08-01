<script lang="ts">
  import type { WorkspaceDto } from "@pi-dash/contracts";
  import { api } from "../../api.js";
  import Modal from "./Modal.svelte";

  export let workspace: WorkspaceDto;
  export let onClose: () => void;
  export let onRenamed: (workspace: WorkspaceDto) => void;

  let name = workspace.name;
  let saving = false;
  let error = "";

  async function rename() {
    if (!name.trim()) {
      error = "Enter a workspace name.";
      return;
    }
    saving = true;
    error = "";
    try {
      const response = await api.renameWorkspace(workspace.id, { name });
      onRenamed(response.workspace);
      onClose();
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to rename the workspace.";
      saving = false;
    }
  }
</script>

<Modal
  title="Rename workspace"
  description="The stable workspace slug and repository path will not change."
  {onClose}
  closeOnEscape={!saving}
  dismissable={!saving}
>
  <form on:submit|preventDefault={rename}>
    <label for="rename-workspace-name">Workspace name</label>
    <input
      id="rename-workspace-name"
      bind:value={name}
      maxlength="100"
      aria-describedby={error ? "rename-workspace-error" : undefined}
      aria-invalid={error ? "true" : undefined}
      disabled={saving}
    />
    {#if error}<p id="rename-workspace-error" class="field-error" role="alert">
        {error}
      </p>{/if}
    <div class="modal-actions">
      <button
        class="button secondary"
        type="button"
        disabled={saving}
        on:click={onClose}>Cancel</button
      >
      <button class="button primary" type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save name"}
      </button>
    </div>
  </form>
</Modal>
