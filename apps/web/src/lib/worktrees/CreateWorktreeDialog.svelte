<script lang="ts">
  import type {
    GitRefDto,
    WorkspaceDto,
    WorktreeDto,
  } from "@pi-dash/contracts";
  import { Edit02Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { afterUpdate, onMount, tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { Button } from "$lib/components/ui/button";
  import * as Command from "$lib/components/ui/command";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Field from "$lib/components/ui/field";
  import { Input } from "$lib/components/ui/input";
  import * as Popover from "$lib/components/ui/popover";
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
  let editingSlug = false;
  let loading = true;
  let saving = false;
  let error = "";
  let operationId = crypto.randomUUID();
  let dialogOpen = true;
  let nameInput: HTMLInputElement | null = null;
  let slugInput: HTMLInputElement | null = null;
  let returnFocus: HTMLElement | null = null;
  let baseOpen = false;
  let baseValue = "";
  let baseTrigger: HTMLButtonElement | null = null;
  let loadedHeadCommit = workspace.repository.headCommit;
  $: selected = refs.find(
    (ref) => `${ref.fullName}:${ref.commit}` === selectedKey,
  );
  $: selectedLabel = selected
    ? `${selected.kind === "tag" ? "tag: " : ""}${selected.name}`
    : "";
  $: branch = slug ? `pi-dash/${slug}` : "pi-dash/…";

  function refKey(ref: GitRefDto): string {
    return `${ref.fullName}:${ref.commit}`;
  }

  function refLabel(ref: GitRefDto): string {
    return `${ref.kind === "tag" ? "tag: " : ""}${ref.name}`;
  }

  function refValue(ref: GitRefDto): string {
    return `${ref.name} ${ref.commit}`;
  }

  function selectBase(ref: GitRefDto): void {
    selectedKey = refKey(ref);
    baseOpen = false;
    void tick().then(() => baseTrigger?.focus());
  }

  $: if (baseOpen && selected) baseValue = refValue(selected);

  afterUpdate(() => {
    const headCommit = workspace.repository.headCommit;
    if (loading || saving || syncing || headCommit === loadedHeadCommit) return;
    loadedHeadCommit = headCommit;
    void loadRefs();
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
  async function showSlugEditor() {
    editingSlug = true;
    await tick();
    slugInput?.focus();
    slugInput?.select();
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
    <Dialog.Header>
      <Dialog.Title>Create worktree</Dialog.Title>
      <Dialog.Description>
        Create a new branch and linked worktree from the selected base.
      </Dialog.Description>
    </Dialog.Header>
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
          <Field.Field data-disabled={saving ? "" : undefined}>
            <Field.Label for="worktree-name">Name</Field.Label>
            <Input
              id="worktree-name"
              bind:ref={nameInput}
              bind:value={name}
              maxlength={100}
              disabled={saving}
              oninput={updateName}
              autocomplete="off"
              placeholder="OAuth refresh"
            />
          </Field.Field>
          <Field.Field
            data-disabled={saving || refs.length === 0 ? "" : undefined}
          >
            <Field.Label for="worktree-base">Base</Field.Label>
            <Popover.Root bind:open={baseOpen}>
              <Popover.Trigger bind:ref={baseTrigger}>
                {#snippet child({ props })}
                  <Button
                    {...props}
                    id="worktree-base"
                    variant="outline"
                    class="w-full justify-between font-normal"
                    role="combobox"
                    aria-expanded={baseOpen}
                    disabled={saving || refs.length === 0}
                  >
                    {#if selected}
                      <span class="min-w-0 truncate">{selectedLabel}</span>
                    {:else}
                      <span class="text-muted-foreground">Select base…</span>
                    {/if}
                    <HugeiconsIcon
                      icon={UnfoldMoreIcon}
                      strokeWidth={2}
                      class="opacity-50"
                      aria-hidden
                    />
                  </Button>
                {/snippet}
              </Popover.Trigger>
              <Popover.Content
                align="start"
                class="w-(--bits-popover-anchor-width) p-0"
              >
                <Command.Root bind:value={baseValue}>
                  <Command.Input
                    autofocus
                    placeholder="Search branch or tag…"
                  />
                  <Command.List>
                    <Command.Empty>No matching refs.</Command.Empty>
                    <Command.Group>
                      {#each refs as ref (refKey(ref))}
                        <Command.Item
                          value={refValue(ref)}
                          keywords={[ref.fullName, ref.kind]}
                          onSelect={() => selectBase(ref)}
                        >
                          <span class="min-w-0 flex-1 truncate">
                            {refLabel(ref)}
                          </span>
                          <span class="shrink-0 text-xs text-muted-foreground">
                            {ref.commit.slice(0, 12)}
                          </span>
                        </Command.Item>
                      {/each}
                    </Command.Group>
                  </Command.List>
                </Command.Root>
              </Popover.Content>
            </Popover.Root>
          </Field.Field>
        </Field.Group>

        {#if editingSlug}
          <Field.Field data-disabled={saving ? "" : undefined}>
            <Field.Label for="worktree-slug">Slug</Field.Label>
            <Input
              id="worktree-slug"
              bind:ref={slugInput}
              bind:value={slug}
              maxlength={72}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              disabled={saving}
              oninput={() => (slugEdited = true)}
              autocomplete="off"
              spellcheck="false"
            />
            <Field.Description
              >Branch will be <code>{branch}</code></Field.Description
            >
          </Field.Field>
        {:else}
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <p class="text-muted-foreground">
              Branch will be <code class="text-foreground">{branch}</code>
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Edit slug"
              class="opacity-50 hover:opacity-100"
              disabled={saving}
              onclick={() => void showSlugEditor()}
            >
              <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
            </Button>
          </div>
        {/if}

        {#if error}<Field.Error>{error}</Field.Error>{/if}
        <Dialog.Footer>
          <Button variant="outline" disabled={saving} onclick={close}
            >Cancel</Button
          >
          <Button
            class="ml-auto"
            type="submit"
            disabled={saving || !selected || !name.trim() || !slug}
          >
            {#if saving}<Spinner data-icon="inline-start" />{/if}{saving
              ? "Creating…"
              : "Create worktree"}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
