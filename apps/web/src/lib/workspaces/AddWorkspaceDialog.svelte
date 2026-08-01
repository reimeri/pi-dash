<script lang="ts">
  import type { WorkspaceDto } from "@pi-dash/contracts";
  import { onMount, tick } from "svelte";
  import { ApiClientError, api } from "../../api.js";
  import Modal from "./Modal.svelte";
  import { displayPath } from "./display.js";

  export let nativeAvailable: boolean;
  export let onClose: () => void;
  export let onCreated: (workspace: WorkspaceDto) => void;
  export let onExisting: (id: string) => void;

  type Step =
    | "choosing"
    | "path"
    | "inspecting"
    | "selection-error"
    | "confirm"
    | "saving";
  let step: Step = nativeAvailable ? "choosing" : "path";
  let typedRecovery = !nativeAvailable;
  let path = "";
  let repositoryPath = "";
  let name = "";
  let error = "";
  let pathInput: HTMLInputElement;
  let nameInput: HTMLInputElement;
  let request: AbortController | undefined;

  function close() {
    if (step === "saving") return;
    request?.abort();
    onClose();
  }

  function messageFor(caught: unknown): string {
    if (caught instanceof ApiClientError) {
      const code = caught.envelope?.error.code;
      if (code === "PATH_NOT_FOUND") return "That directory no longer exists.";
      if (code === "PATH_INACCESSIBLE")
        return "Pi Dash cannot access that directory.";
      if (code === "NOT_A_GIT_WORKTREE")
        return "Choose a directory inside a non-bare Git worktree.";
      if (code === "GIT_UNAVAILABLE")
        return "Git is unavailable to the Pi Dash daemon.";
      if (code === "GIT_TIMEOUT") return "Git inspection timed out. Try again.";
      if (code === "DIALOG_BUSY")
        return "Another directory dialog is already open.";
      return caught.message;
    }
    return caught instanceof Error
      ? caught.message
      : "The workspace could not be inspected.";
  }

  async function inspect(selectedPath: string) {
    step = "inspecting";
    error = "";
    request = new AbortController();
    try {
      const preview = await api.inspectWorkspace(
        { path: selectedPath },
        request.signal,
      );
      repositoryPath = preview.repositoryPath;
      path = selectedPath;
      name = preview.defaultName;
      step = "confirm";
      await tick();
      nameInput?.focus();
      nameInput?.select();
    } catch (caught) {
      if (request.signal.aborted) return;
      error = messageFor(caught);
      step = typedRecovery ? "path" : "selection-error";
      await tick();
      pathInput?.focus();
    }
  }

  async function chooseNative() {
    step = "choosing";
    error = "";
    request = new AbortController();
    try {
      const selection = await api.chooseWorkspaceDirectory(request.signal);
      if (selection.cancelled || !selection.path) {
        close();
        return;
      }
      await inspect(selection.path);
    } catch (caught) {
      if (request.signal.aborted) return;
      if (
        caught instanceof ApiClientError &&
        caught.envelope?.error.code === "DIALOG_UNAVAILABLE"
      ) {
        typedRecovery = true;
        step = "path";
        error =
          "No native directory picker is available. Enter an absolute repository path instead.";
        await tick();
        pathInput?.focus();
        return;
      }
      error = messageFor(caught);
      step = "selection-error";
    }
  }

  async function submitPath() {
    if (path.length === 0) {
      error = "Enter a directory path.";
      return;
    }
    await inspect(path);
  }

  async function create() {
    if (!name.trim()) {
      error = "Enter a workspace name.";
      return;
    }
    step = "saving";
    error = "";
    request = new AbortController();
    try {
      const response = await api.createWorkspace(
        { path: repositoryPath, name },
        request.signal,
      );
      onCreated(response.workspace);
      onClose();
    } catch (caught) {
      if (request.signal.aborted) return;
      if (
        caught instanceof ApiClientError &&
        caught.envelope?.error.code === "WORKSPACE_EXISTS"
      ) {
        const details = caught.envelope.error.details;
        if (
          typeof details === "object" &&
          details !== null &&
          "workspaceId" in details &&
          typeof details.workspaceId === "string"
        ) {
          onExisting(details.workspaceId);
        }
        error = "This repository is already registered.";
      } else {
        error = messageFor(caught);
      }
      step = "confirm";
      await tick();
      nameInput?.focus();
    }
  }

  onMount(() => {
    if (nativeAvailable) {
      void chooseNative();
      return;
    }
    const focusTimer = setTimeout(() => pathInput?.focus(), 0);
    return () => clearTimeout(focusTimer);
  });
</script>

<Modal
  title="Add workspace"
  description={step === "choosing"
    ? "A system directory dialog is active. It may appear behind this window."
    : "Register an existing local Git worktree. Repository files will not be changed."}
  onClose={close}
  closeOnEscape={step !== "saving"}
  dismissable={step !== "saving"}
>
  {#if step === "choosing"}
    <div class="dialog-progress" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>Waiting for the system directory picker…</p>
    </div>
    <div class="modal-actions">
      <button class="button secondary" type="button" on:click={close}
        >Cancel</button
      >
    </div>
  {:else if step === "path" || step === "inspecting"}
    <form on:submit|preventDefault={submitPath}>
      <label for="workspace-path">Repository directory</label>
      <input
        id="workspace-path"
        bind:this={pathInput}
        bind:value={path}
        aria-describedby={error ? "add-workspace-error" : "workspace-path-help"}
        aria-invalid={error ? "true" : undefined}
        autocomplete="off"
        spellcheck="false"
        placeholder="/home/user/src/project"
        disabled={step === "inspecting"}
      />
      <p id="workspace-path-help" class="field-help">
        The path is canonicalized and validated by Git before it is saved.
      </p>
      {#if error}<p id="add-workspace-error" class="field-error" role="alert">
          {error}
        </p>{/if}
      <div class="modal-actions">
        <button class="button secondary" type="button" on:click={close}
          >Cancel</button
        >
        <button
          class="button primary"
          type="submit"
          disabled={step === "inspecting"}
        >
          {step === "inspecting" ? "Inspecting…" : "Continue"}
        </button>
      </div>
    </form>
  {:else if step === "selection-error"}
    <div class="inline-alert" role="alert">
      <strong>Unable to use that selection</strong>
      <p>{error}</p>
      {#if path}<code>{displayPath(path)}</code>{/if}
    </div>
    <div class="modal-actions">
      <button class="button secondary" type="button" on:click={close}
        >Cancel</button
      >
      <button class="button primary" type="button" on:click={chooseNative}
        >Choose another</button
      >
    </div>
  {:else}
    <form on:submit|preventDefault={create}>
      <div class="resolved-path">
        <span>Repository</span>
        <code>{displayPath(repositoryPath)}</code>
      </div>
      <label for="workspace-name">Workspace name</label>
      <input
        id="workspace-name"
        bind:this={nameInput}
        bind:value={name}
        maxlength="100"
        aria-describedby={error ? "add-workspace-error" : undefined}
        aria-invalid={error ? "true" : undefined}
        disabled={step === "saving"}
      />
      {#if error}<p id="add-workspace-error" class="field-error" role="alert">
          {error}
        </p>{/if}
      <div class="modal-actions">
        <button
          class="button secondary"
          type="button"
          disabled={step === "saving"}
          on:click={close}>Cancel</button
        >
        <button
          class="button primary"
          type="submit"
          disabled={step === "saving"}
        >
          {step === "saving" ? "Adding…" : "Add workspace"}
        </button>
      </div>
    </form>
  {/if}
</Modal>
