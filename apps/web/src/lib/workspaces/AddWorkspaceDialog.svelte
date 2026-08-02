<script lang="ts">
  import type { WorkspaceDto } from "@pi-dash/contracts";
  import { FolderOpenIcon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onMount, tick } from "svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Field from "$lib/components/ui/field";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import { ApiClientError, api } from "../../api.js";
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
  let pathInput: HTMLInputElement | null = null;
  let nameInput: HTMLInputElement | null = null;
  let request: AbortController | undefined;
  let returnFocus: HTMLElement | null = null;
  let dialogOpen = true;

  function restoreFocus(): void {
    requestAnimationFrame(
      () => returnFocus?.isConnected && returnFocus.focus(),
    );
  }

  function close() {
    if (step === "saving") return;
    request?.abort();
    onClose();
    restoreFocus();
  }

  function finishClose(): void {
    onClose();
    restoreFocus();
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
      finishClose();
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
      } else error = messageFor(caught);
      step = "confirm";
      await tick();
      nameInput?.focus();
    }
  }

  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (nativeAvailable) {
      void chooseNative();
      return;
    }
    const focusTimer = setTimeout(() => pathInput?.focus(), 0);
    return () => clearTimeout(focusTimer);
  });
</script>

<Dialog.Root bind:open={dialogOpen}>
  <Dialog.Content
    showCloseButton={false}
    onEscapeKeydown={(event) => {
      event.preventDefault();
      if (step !== "saving") close();
    }}
    onInteractOutside={(event) => {
      event.preventDefault();
      if (step !== "saving") close();
    }}
  >
    <Dialog.Header>
      <Dialog.Title>Add workspace</Dialog.Title>
      <Dialog.Description>
        {step === "choosing"
          ? "A system directory dialog is active. It may appear behind this window."
          : "Register an existing local Git worktree. Repository files will not be changed."}
      </Dialog.Description>
    </Dialog.Header>

    {#if step === "choosing"}
      <div class="flex flex-col items-center gap-3 py-4" role="status">
        <Spinner />
        <p class="text-sm text-muted-foreground">
          Waiting for the system directory picker…
        </p>
      </div>
      <Dialog.Footer
        ><Button variant="outline" onclick={close}>Cancel</Button
        ></Dialog.Footer
      >
    {:else if step === "path" || step === "inspecting"}
      <form class="flex flex-col gap-6" on:submit|preventDefault={submitPath}>
        <Field.Group>
          <Field.Field
            data-invalid={error ? "" : undefined}
            data-disabled={step === "inspecting" ? "" : undefined}
          >
            <Field.Label for="workspace-path">Repository directory</Field.Label>
            <Input
              id="workspace-path"
              bind:ref={pathInput}
              bind:value={path}
              aria-describedby={error
                ? "add-workspace-error"
                : "workspace-path-help"}
              aria-invalid={error ? "true" : undefined}
              autocomplete="off"
              spellcheck="false"
              placeholder="/home/user/src/project"
              disabled={step === "inspecting"}
            />
            <Field.Description id="workspace-path-help"
              >The path is canonicalized and validated by Git before it is
              saved.</Field.Description
            >
            {#if error}<Field.Error id="add-workspace-error"
                >{error}</Field.Error
              >{/if}
          </Field.Field>
        </Field.Group>
        <Dialog.Footer>
          <Button
            variant="outline"
            disabled={step === "inspecting"}
            onclick={close}>Cancel</Button
          >
          <Button type="submit" disabled={step === "inspecting"}
            >{#if step === "inspecting"}<Spinner
                data-icon="inline-start"
              />{/if}{step === "inspecting"
              ? "Inspecting…"
              : "Continue"}</Button
          >
        </Dialog.Footer>
      </form>
    {:else if step === "selection-error"}
      <Alert.Root variant="destructive" role="alert"
        ><Alert.Title>Unable to use that selection</Alert.Title
        ><Alert.Description
          >{error}{#if path}<code class="mt-2 block break-all"
              >{displayPath(path)}</code
            >{/if}</Alert.Description
        ></Alert.Root
      >
      <Dialog.Footer
        ><Button variant="outline" onclick={close}>Cancel</Button><Button
          onclick={chooseNative}
          ><HugeiconsIcon
            icon={FolderOpenIcon}
            strokeWidth={2}
            data-icon="inline-start"
          />Choose another</Button
        ></Dialog.Footer
      >
    {:else}
      <form class="flex flex-col gap-6" on:submit|preventDefault={create}>
        <Alert.Root role="note"
          ><Alert.Title>Repository</Alert.Title><Alert.Description
            ><code class="break-all">{displayPath(repositoryPath)}</code
            ></Alert.Description
          ></Alert.Root
        >
        <Field.Group>
          <Field.Field
            data-invalid={error ? "" : undefined}
            data-disabled={step === "saving" ? "" : undefined}
          >
            <Field.Label for="workspace-name">Workspace name</Field.Label>
            <Input
              id="workspace-name"
              bind:ref={nameInput}
              bind:value={name}
              maxlength={100}
              aria-describedby={error ? "add-workspace-error" : undefined}
              aria-invalid={error ? "true" : undefined}
              disabled={step === "saving"}
            />
            {#if error}<Field.Error id="add-workspace-error"
                >{error}</Field.Error
              >{/if}
          </Field.Field>
        </Field.Group>
        <Dialog.Footer>
          <Button variant="outline" disabled={step === "saving"} onclick={close}
            >Cancel</Button
          >
          <Button type="submit" disabled={step === "saving"}
            >{#if step === "saving"}<Spinner
                data-icon="inline-start"
              />{/if}{step === "saving" ? "Adding…" : "Add workspace"}</Button
          >
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
