<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import {
    AlertCircleIcon,
    FileEditIcon,
    RefreshIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Empty from "$lib/components/ui/empty";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import type { WorktreeDiffState } from "./store.js";
  import PierreDiffView from "./PierreDiffView.svelte";

  export let worktree: WorktreeDto;
  export let state: WorktreeDiffState;
  export let onRefresh: () => void;
  export let onClose: () => void;

  let rendererError = "";

  function fileLabel(count: number): string {
    return `${count} ${count === 1 ? "file" : "files"}`;
  }
</script>

<section
  id="worktree-diff-viewer"
  class="flex size-full min-h-0 flex-col bg-card"
  aria-labelledby="diff-viewer-title"
>
  <header class="flex items-start gap-3 border-b p-4 pr-3">
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        <h2 id="diff-viewer-title" class="truncate font-semibold">Changes</h2>
        {#if state.summary}
          <Badge variant="outline"
            >{fileLabel(state.summary.filesChanged)}</Badge
          >
        {/if}
      </div>
      <p class="mt-1 truncate text-xs text-muted-foreground">
        {worktree.branchRef.replace("refs/heads/", "")} against
        {state.summary?.headCommit.slice(0, 12) ?? "worktree HEAD"}
      </p>
      {#if state.summary?.hasChanges}
        <p class="mt-2 flex items-center gap-2 font-mono text-xs">
          <span class="text-diff-addition">+{state.summary.additions}</span>
          <span class="text-diff-deletion">−{state.summary.deletions}</span>
          {#if state.summary.binaryFiles > 0}
            <span class="text-muted-foreground"
              >{state.summary.binaryFiles} binary</span
            >
          {/if}
        </p>
      {/if}
    </div>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Refresh changes"
      title="Refresh changes"
      disabled={state.status === "loading" && !state.summary}
      onclick={onRefresh}
    >
      <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
    </Button>
  </header>

  <div class="flex min-h-0 flex-1 flex-col">
    {#if state.status === "loading" && !state.summary}
      <div
        class="flex flex-col gap-3 p-4"
        role="status"
        aria-label="Loading changes"
      >
        <Skeleton class="h-8 w-2/3" />
        <Skeleton class="h-24 w-full" />
        <Skeleton class="h-40 w-full" />
      </div>
    {:else if state.status === "error" && !state.diff}
      <Alert.Root variant="destructive" class="m-4" role="alert">
        <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
        <Alert.Title>Unable to load changes</Alert.Title>
        <Alert.Description>{state.message}</Alert.Description>
        <Alert.Action>
          <Button variant="outline" size="sm" onclick={onRefresh}>Retry</Button>
        </Alert.Action>
      </Alert.Root>
    {:else if state.summary && !state.summary.hasChanges}
      <Empty.Root class="h-full">
        <Empty.Header>
          <Empty.Media variant="icon">
            <HugeiconsIcon icon={FileEditIcon} strokeWidth={2} />
          </Empty.Media>
          <Empty.Title role="heading" aria-level={3}>No changes</Empty.Title>
          <Empty.Description>
            This worktree matches its branch’s newest commit.
          </Empty.Description>
        </Empty.Header>
      </Empty.Root>
    {:else if state.diff}
      {#if state.status === "error" || rendererError}
        <Alert.Root variant="destructive" class="m-3" role="alert">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <Alert.Title>Changes may be stale</Alert.Title>
          <Alert.Description>{rendererError || state.message}</Alert.Description
          >
        </Alert.Root>
      {/if}
      {#if state.diff.truncated}
        <Alert.Root class="m-3" role="status">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <Alert.Title>Some files were omitted</Alert.Title>
          <Alert.Description>
            {state.diff.omittedFiles.length} changed
            {state.diff.omittedFiles.length === 1
              ? " file exceeds"
              : " files exceed"}
            the safe rendering limits.
          </Alert.Description>
        </Alert.Root>
      {/if}
      {#if state.diff.patch}
        <div class="min-h-0 flex-1">
          <PierreDiffView
            patch={state.diff.patch}
            snapshotId={state.diff.snapshotId}
            onError={(message) => (rendererError = message)}
          />
        </div>
      {:else}
        <Empty.Root class="h-full">
          <Empty.Header>
            <Empty.Media variant="icon">
              <HugeiconsIcon icon={FileEditIcon} strokeWidth={2} />
            </Empty.Media>
            <Empty.Title role="heading" aria-level={3}
              >No renderable text changes</Empty.Title
            >
            <Empty.Description>
              The changed files are binary or exceed the safe rendering limits.
            </Empty.Description>
          </Empty.Header>
        </Empty.Root>
      {/if}
    {/if}
  </div>
</section>
