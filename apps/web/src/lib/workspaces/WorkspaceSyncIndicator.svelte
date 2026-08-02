<script lang="ts">
  import type { WorkspaceSyncStatus } from "@pi-dash/contracts";
  import {
    GitMergeConflictIcon,
    RefreshIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";

  export let status: WorkspaceSyncStatus;

  $: label =
    status === "syncable"
      ? "Upstream updates available"
      : "Branch diverged from upstream";
</script>

{#if status === "syncable"}
  <span
    class="inline-flex shrink-0 text-muted-foreground [&_svg]:size-4"
    role="img"
    aria-label={label}
    title="Upstream updates available"
  >
    <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
  </span>
{:else if status === "diverged"}
  <span
    class="inline-flex shrink-0 text-destructive [&_svg]:size-4"
    role="img"
    aria-label={label}
    title="Branch diverged from upstream"
  >
    <HugeiconsIcon icon={GitMergeConflictIcon} strokeWidth={2} />
  </span>
{/if}
