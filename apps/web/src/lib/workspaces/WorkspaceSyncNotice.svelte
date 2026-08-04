<script lang="ts">
  import type { WorkspaceSyncStatus } from "@pi-dash/contracts";
  import {
    FileEditIcon,
    GitMergeConflictIcon,
    RefreshIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";

  export let status: WorkspaceSyncStatus;
  export let context: "workspace" | "worktree" = "workspace";
  export let syncing = false;
  export let onSync: (() => void) | undefined = undefined;

  $: syncable = status === "syncable";
  $: diverged = status === "diverged";
  $: dirty = status === "dirty";
</script>

{#if syncable}
  <Alert.Root role="status">
    <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
    <Alert.Title>Workspace is behind upstream HEAD</Alert.Title>
    <Alert.Description>
      {#if context === "worktree"}
        This workspace’s base commit is not upstream HEAD. New worktrees will
        start from the local base until you sync.
      {:else}
        The workspace branch is behind its upstream tracking branch. Sync to
        fast-forward to upstream HEAD before creating worktrees from it.
      {/if}
    </Alert.Description>
    {#if onSync}
      <Alert.Action>
        <Button size="sm" variant="outline" disabled={syncing} onclick={onSync}>
          {#if syncing}<Spinner data-icon="inline-start" />{/if}
          {syncing ? "Syncing…" : "Sync"}
        </Button>
      </Alert.Action>
    {/if}
  </Alert.Root>
{:else if diverged}
  <Alert.Root variant="destructive" role="status">
    <HugeiconsIcon icon={GitMergeConflictIcon} strokeWidth={2} />
    <Alert.Title>Branch diverged from upstream</Alert.Title>
    <Alert.Description>
      {#if context === "worktree"}
        Workspace HEAD and upstream have diverged. Reconcile the branch manually
        before relying on this base for new worktrees.
      {:else}
        The workspace branch and its upstream have diverged. Reconcile them
        manually; automatic sync will not rewrite local commits.
      {/if}
    </Alert.Description>
  </Alert.Root>
{:else if dirty}
  <Alert.Root role="status">
    <HugeiconsIcon icon={FileEditIcon} strokeWidth={2} />
    <Alert.Title>Workspace has local changes</Alert.Title>
    <Alert.Description>
      {#if context === "worktree"}
        Uncommitted changes are not included in new worktrees. Commit, stash, or
        discard them before relying on this workspace as a clean base.
      {:else}
        Commit, stash, or discard the local changes before syncing this
        workspace with upstream.
      {/if}
    </Alert.Description>
  </Alert.Root>
{/if}
