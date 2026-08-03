<script lang="ts">
  import type {
    GitRefDto,
    WorkspaceDto,
    WorktreeDto,
  } from "@pi-dash/contracts";
  import { GitBranchIcon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onMount, tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Field from "$lib/components/ui/field";
  import { Input } from "$lib/components/ui/input";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { Spinner } from "$lib/components/ui/spinner";
  import { ApiClientError, api } from "../../api.js";
  import WorkspaceSyncNotice from "../workspaces/WorkspaceSyncNotice.svelte";

  export let workspace: WorkspaceDto;
  export let syncing = false;
  export let onSync: (() => void) | undefined = undefined;
  export let onClose: () => void;
  export let onCreated: (worktree: WorktreeDto) => void;

  let refs: GitRefDto[] = [];
  let selectedKey = "";
  let name = "";
  let slug = "";
  let slugEdited = false;
  let loading = true;
  let saving = false;
  let error = "";
  let operationId = crypto.randomUUID();
  let dialogOpen = true;
  let nameInput: HTMLInputElement | null = null;
  let returnFocus: HTMLElement | null = null;
  let loadedHeadCommit = workspace.repository.headCommit;
  $: selected = refs.find(
    (ref) => `${ref.fullName}:${ref.commit}` === selectedKey,
  );
  $: branch = slug ? `pi-dash/${slug}` : "pi-dash/…";
  $: if (
    !loading &&
    !saving &&
    !syncing &&
    workspace.repository.headCommit !== loadedHeadCommit
  ) {
    loadedHeadCommit = workspace.repository.headCommit;
    void loadRefs();
  }

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
  function slugFor(value: string): string {
    return (
      value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 72)
        .replace(/-+$/g, "") || "worktree"
    );
  }
  function updateName() {
    if (!slugEdited) slug = slugFor(name);
  }
  async function loadRefs() {
    loading = true;
    error = "";
    try {
      const response = await api.worktreeRefs(workspace.id);
      const combined = [
        ...(response.head ? [response.head] : []),
        ...response.refs,
      ];
      const seen = new SvelteSet<string>();
      refs = combined.filter((ref) => {
        const key = `${ref.fullName}:${ref.commit}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      selectedKey = refs[0] ? `${refs[0].fullName}:${refs[0].commit}` : "";
      loadedHeadCommit = workspace.repository.headCommit;
      if (!selectedKey)
        error = "Repository has no commit that can be used as a base.";
    } catch (caught) {
      error =
        caught instanceof Error ? caught.message : "Unable to load Git refs.";
    } finally {
      loading = false;
    }
  }
  async function create() {
    if (!selected || !name.trim() || !slug) return;
    saving = true;
    error = "";
    try {
      const response = await api.createWorktree(
        workspace.id,
        {
          name,
          slug,
          baseRef: selected.fullName,
          baseCommit: selected.commit,
          baseSnapshotToken: selected.baseSnapshotToken,
        },
        operationId,
      );
      onCreated(response.worktree);
      finishClose();
    } catch (caught) {
      if (
        caught instanceof ApiClientError &&
        caught.envelope?.error.code === "SNAPSHOT_INVALID"
      ) {
        operationId = crypto.randomUUID();
        await loadRefs();
        error =
          "The base snapshot expired. Recheck the refreshed base and submit again.";
      } else {
        error =
          caught instanceof Error
            ? caught.message
            : "Unable to create worktree.";
        if (caught instanceof ApiClientError) operationId = crypto.randomUUID();
      }
      saving = false;
    }
  }
  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void (async () => {
      await loadRefs();
      await tick();
      nameInput?.focus();
    })();
  });
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
      ><Dialog.Title>Create managed worktree</Dialog.Title><Dialog.Description
        >Create a new branch and linked worktree from an exact commit snapshot.</Dialog.Description
      ></Dialog.Header
    >
    {#if workspace.repository.health === "healthy"}
      <WorkspaceSyncNotice
        status={workspace.repository.syncStatus}
        context="worktree"
        {syncing}
        {onSync}
      />
    {/if}
    {#if loading}
      <div
        class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />Resolving local branches and tags…
      </div>
    {:else}
      <form class="flex flex-col gap-6" on:submit|preventDefault={create}>
        <p class="sr-only" role="status" aria-live="polite">
          {saving ? "Creating managed worktree" : ""}
        </p>
        <Field.Group>
          <Field.Field data-disabled={saving ? "" : undefined}
            ><Field.Label for="worktree-name">Name</Field.Label><Input
              id="worktree-name"
              bind:ref={nameInput}
              bind:value={name}
              maxlength={100}
              disabled={saving}
              oninput={updateName}
              autocomplete="off"
              placeholder="OAuth refresh"
            /></Field.Field
          >
          <Field.Field data-disabled={saving ? "" : undefined}
            ><Field.Label for="worktree-slug">Slug</Field.Label><Input
              id="worktree-slug"
              bind:value={slug}
              maxlength={72}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              disabled={saving}
              oninput={() => (slugEdited = true)}
              autocomplete="off"
              spellcheck="false"
            /></Field.Field
          >
          <Field.Field
            data-disabled={saving || refs.length === 0 ? "" : undefined}
            ><Field.Label for="worktree-base">Base</Field.Label
            ><NativeSelect.Root
              id="worktree-base"
              bind:value={selectedKey}
              disabled={saving || refs.length === 0}
              >{#each refs as ref (`${ref.fullName}:${ref.commit}`)}<NativeSelect.Option
                  value={`${ref.fullName}:${ref.commit}`}
                  >{ref.kind === "tag" ? "tag: " : ""}{ref.name} — {ref.commit.slice(
                    0,
                    12,
                  )}</NativeSelect.Option
                >{/each}</NativeSelect.Root
            ></Field.Field
          >
        </Field.Group>
        {#if selected}
          <Alert.Root role="note"
            ><HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} /><Alert.Title
              >Exact worktree snapshot</Alert.Title
            ><Alert.Description
              ><dl class="mt-2 grid gap-2 text-xs">
                <div>
                  <dt class="text-muted-foreground">Exact base commit</dt>
                  <dd><code class="break-all">{selected.commit}</code></dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">New branch</dt>
                  <dd><code>{branch}</code></dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">Managed path</dt>
                  <dd>
                    <code class="break-all"
                      >…/worktrees/{workspace.id}/&lt;id&gt;-{slug ||
                        "slug"}</code
                    >
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">Snapshot expires</dt>
                  <dd>{new Date(selected.expiresAt).toLocaleTimeString()}</dd>
                </div>
              </dl></Alert.Description
            ></Alert.Root
          >
        {/if}
        {#if error}<Field.Error>{error}</Field.Error>{/if}
        <Dialog.Footer
          ><Button variant="outline" disabled={saving} onclick={close}
            >Cancel</Button
          ><Button
            class="ml-auto"
            type="submit"
            disabled={saving || !selected || !name.trim() || !slug}
            >{#if saving}<Spinner data-icon="inline-start" />{/if}{saving
              ? "Creating…"
              : "Create worktree"}</Button
          ></Dialog.Footer
        >
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
