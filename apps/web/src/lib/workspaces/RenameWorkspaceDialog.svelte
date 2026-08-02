<script lang="ts">
  import type { WorkspaceDto } from "@pi-dash/contracts";
  import { onMount } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Field from "$lib/components/ui/field";
  import { Input } from "$lib/components/ui/input";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import { api } from "../../api.js";

  export let workspace: WorkspaceDto;
  export let onClose: () => void;
  export let onRenamed: (workspace: WorkspaceDto) => void;

  let name = workspace.name;
  let saving = false;
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
    requestAnimationFrame(
      () => returnFocus?.isConnected && returnFocus.focus(),
    );
  }

  function close() {
    if (saving) return;
    onClose();
    restoreFocus();
  }

  function finishClose(): void {
    onClose();
    restoreFocus();
  }
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
      finishClose();
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to rename the workspace.";
      saving = false;
    }
  }
</script>

<Dialog.Root bind:open={dialogOpen}>
  <Dialog.Content
    showCloseButton={false}
    onEscapeKeydown={(event) => {
      event.preventDefault();
      if (!saving) close();
    }}
    onInteractOutside={(event) => {
      event.preventDefault();
      if (!saving) close();
    }}
  >
    <Dialog.Header
      ><Dialog.Title>Rename workspace</Dialog.Title><Dialog.Description
        >The stable workspace slug and repository path will not change.</Dialog.Description
      ></Dialog.Header
    >
    <form class="flex flex-col gap-6" on:submit|preventDefault={rename}>
      <Field.Group>
        <Field.Field
          data-invalid={error ? "" : undefined}
          data-disabled={saving ? "" : undefined}
        >
          <Field.Label for="rename-workspace-name">Workspace name</Field.Label>
          <Input
            id="rename-workspace-name"
            bind:value={name}
            maxlength={100}
            aria-describedby={error ? "rename-workspace-error" : undefined}
            aria-invalid={error ? "true" : undefined}
            disabled={saving}
            autofocus
          />
          {#if error}<Field.Error id="rename-workspace-error"
              >{error}</Field.Error
            >{/if}
        </Field.Field>
      </Field.Group>
      <Dialog.Footer
        ><Button variant="outline" disabled={saving} onclick={close}
          >Cancel</Button
        ><Button type="submit" disabled={saving}
          >{#if saving}<Spinner data-icon="inline-start" />{/if}{saving
            ? "Saving…"
            : "Save name"}</Button
        ></Dialog.Footer
      >
    </form>
  </Dialog.Content>
</Dialog.Root>
