<script lang="ts">
  import type {
    GitRefDto,
    WorkspaceDto,
    WorktreeDto,
  } from "@pi-dash/contracts";
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { ApiClientError, api } from "../../api.js";
  import Modal from "../workspaces/Modal.svelte";

  export let workspace: WorkspaceDto;
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

  $: selected = refs.find(
    (ref) => `${ref.fullName}:${ref.commit}` === selectedKey,
  );
  $: branch = slug ? `pi-dash/${slug}` : "pi-dash/…";

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
      onClose();
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

  onMount(() => void loadRefs());
</script>

<Modal
  title="Create managed worktree"
  description="Create a new branch and linked worktree from an exact commit snapshot."
  {onClose}
  closeOnEscape={!saving}
  dismissable={!saving}
>
  {#if loading}
    <div class="dialog-progress" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>Resolving local branches and tags…</p>
    </div>
  {:else}
    <form on:submit|preventDefault={create}>
      <p class="sr-only" role="status" aria-live="polite">
        {saving ? "Creating managed worktree" : ""}
      </p>
      <label for="worktree-name">Name</label>
      <input
        id="worktree-name"
        bind:value={name}
        maxlength="100"
        disabled={saving}
        on:input={updateName}
        autocomplete="off"
        placeholder="OAuth refresh"
      />
      <label for="worktree-slug">Slug</label>
      <input
        id="worktree-slug"
        bind:value={slug}
        maxlength="72"
        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
        disabled={saving}
        on:input={() => (slugEdited = true)}
        autocomplete="off"
        spellcheck="false"
      />
      <label for="worktree-base">Base</label>
      <select
        id="worktree-base"
        bind:value={selectedKey}
        disabled={saving || refs.length === 0}
      >
        {#each refs as ref (`${ref.fullName}:${ref.commit}`)}
          <option value={`${ref.fullName}:${ref.commit}`}>
            {ref.kind === "tag" ? "tag: " : ""}{ref.name} — {ref.commit.slice(
              0,
              12,
            )}
          </option>
        {/each}
      </select>
      {#if selected}
        <div class="resolved-path worktree-preview">
          <span>Exact base commit</span>
          <code>{selected.commit}</code>
          <span>New branch</span>
          <code>{branch}</code>
          <span>Managed path</span>
          <code>…/worktrees/{workspace.id}/&lt;id&gt;-{slug || "slug"}</code>
          <span>Snapshot expires</span>
          <code>{new Date(selected.expiresAt).toLocaleTimeString()}</code>
        </div>
      {/if}
      {#if error}<p class="field-error" role="alert">{error}</p>{/if}
      <div class="modal-actions">
        <button
          class="button secondary"
          type="button"
          disabled={saving}
          on:click={onClose}>Cancel</button
        >
        <button
          class="button primary"
          type="submit"
          disabled={saving || !selected || !name.trim() || !slug}
          >{saving ? "Creating…" : "Create worktree"}</button
        >
      </div>
    </form>
  {/if}
</Modal>
