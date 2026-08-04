<script lang="ts">
  import type { WorkspaceDto, WorktreeDto } from "@pi-dash/contracts";
  import {
    Add01Icon,
    AlertCircleIcon,
    ArrowReloadHorizontalIcon,
    GitBranchIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Empty from "$lib/components/ui/empty";
  import { Spinner } from "$lib/components/ui/spinner";
  import WorktreeCard from "./WorktreeCard.svelte";

  export let workspace: WorkspaceDto;
  export let worktrees: WorktreeDto[];
  export let loading: boolean;
  export let error: string | undefined;
  export let reconciling: boolean;
  export let onReconcile: () => void;
  export let onCreate: () => void;
  export let onOpen: (worktree: WorktreeDto) => void;
  export let onRemove: (worktree: WorktreeDto) => void;
  export let onDeleteBranch: (worktree: WorktreeDto) => void;
</script>

<section class="flex flex-col gap-4" aria-labelledby="worktree-heading">
  <div class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
    <div>
      <h3 id="worktree-heading" class="text-lg font-semibold">
        Isolated branches
      </h3>
      <p class="text-sm text-muted-foreground">Managed worktrees</p>
    </div>
    <div class="flex gap-2">
      <Button variant="outline" disabled={reconciling} onclick={onReconcile}>
        {#if reconciling}<Spinner data-icon="inline-start" />{:else}<HugeiconsIcon
            icon={ArrowReloadHorizontalIcon}
            strokeWidth={2}
            data-icon="inline-start"
          />{/if}
        {reconciling ? "Reconciling…" : "Reconcile"}
      </Button>
      <Button
        disabled={workspace.repository.health !== "healthy"}
        onclick={onCreate}
      >
        <HugeiconsIcon
          icon={Add01Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />Create worktree
      </Button>
    </div>
  </div>
  {#if loading && worktrees.length === 0}
    <div
      class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
      role="status"
    >
      <Spinner aria-hidden="true" />Loading managed worktrees…
    </div>
  {:else if error}
    <Alert.Root variant="destructive" role="alert"
      ><HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} /><Alert.Description
        >{error}</Alert.Description
      ></Alert.Root
    >
  {:else if worktrees.length === 0}
    <Empty.Root class="border">
      <Empty.Header>
        <Empty.Media variant="icon"
          ><HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} /></Empty.Media
        >
        <Empty.Title role="heading" aria-level={3}
          >No managed worktrees</Empty.Title
        >
        <Empty.Description
          >Create an isolated branch and linked worktree from an exact local
          commit.</Empty.Description
        >
      </Empty.Header>
    </Empty.Root>
  {:else}
    <div class="flex flex-col gap-2">
      {#each worktrees as worktree (worktree.id)}
        <WorktreeCard
          {worktree}
          {onOpen}
          {onRemove}
          {onDeleteBranch}
          {onReconcile}
        />
      {/each}
    </div>
  {/if}
</section>
