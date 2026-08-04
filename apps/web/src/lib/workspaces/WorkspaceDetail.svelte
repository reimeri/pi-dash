<script lang="ts">
  import type { WorkspaceDto, WorktreeDto } from "@pi-dash/contracts";
  import {
    Delete02Icon,
    Edit02Icon,
    RefreshIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import { Separator } from "$lib/components/ui/separator";
  import { Spinner } from "$lib/components/ui/spinner";
  import { displayPath } from "./display.js";
  import { healthLabel, repositoryHealthIssue } from "./health.js";
  import HealthBadge from "./HealthBadge.svelte";
  import { syncStatusLabel } from "./sync.js";
  import WorkspaceSyncIndicator from "./WorkspaceSyncIndicator.svelte";
  import WorkspaceSyncNotice from "./WorkspaceSyncNotice.svelte";
  import WorktreeSection from "../worktrees/WorktreeSection.svelte";

  export let workspace: WorkspaceDto;
  export let worktrees: WorktreeDto[];
  export let worktreeLoading: boolean;
  export let worktreeError: string | undefined;
  export let refreshing: boolean;
  export let syncing: boolean;
  export let reconciling: boolean;
  export let onRename: () => void;
  export let onRemove: () => void;
  export let onSync: () => void;
  export let onRefresh: () => void;
  export let onReconcile: () => void;
  export let onCreateWorktree: () => void;
  export let onOpenWorktree: (worktree: WorktreeDto) => void;
  export let onRemoveWorktree: (worktree: WorktreeDto) => void;
  export let onDeleteBranch: (worktree: WorktreeDto) => void;

  $: repositoryIssue = repositoryHealthIssue(workspace.repository.health);
</script>

<section
  class="mx-auto flex w-full max-w-5xl flex-col gap-6"
  aria-labelledby="workspace-title"
>
  <header class="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
    <div class="min-w-0">
      <Badge variant="outline">Workspace</Badge>
      <h2
        id="workspace-title"
        class="mt-3 flex items-center gap-2 text-2xl font-semibold tracking-tight"
      >
        <span class="min-w-0 truncate">{workspace.name}</span>
        <WorkspaceSyncIndicator status={workspace.repository.syncStatus} />
        {#if refreshing}
          <Spinner
            class="size-4 text-muted-foreground"
            aria-label="Refreshing sync status"
          />
        {/if}
      </h2>
      <p class="mt-1 break-all font-mono text-sm text-muted-foreground">
        {displayPath(workspace.repositoryPath)}
      </p>
    </div>
    <div class="flex gap-2">
      <Button variant="outline" onclick={onRename}>
        <HugeiconsIcon
          icon={Edit02Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />Rename
      </Button>
      <Button variant="destructive" onclick={onRemove}>
        <HugeiconsIcon
          icon={Delete02Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />Remove
      </Button>
    </div>
  </header>

  {#if workspace.repository.health === "healthy"}
    <WorkspaceSyncNotice
      status={workspace.repository.syncStatus}
      {syncing}
      onSync={onSync}
    />
  {/if}

  <Card.Root>
    <Card.Header>
      <div>
        <Card.Title
          >{workspace.repository.health === "healthy"
            ? "Repository ready"
            : "Repository needs attention"}</Card.Title
        >
        <Card.Description
          >Repository health and recorded workspace details.</Card.Description
        >
      </div>
      <Card.Action>
        <HealthBadge
          label={healthLabel(workspace.repository.health)}
          subject="Repository"
          issue={repositoryIssue}
          details={[
            {
              label: "Path",
              value: displayPath(workspace.repositoryPath),
            },
            ...(workspace.repository.checkedAt
              ? [
                  {
                    label: "Checked",
                    value: new Date(
                      workspace.repository.checkedAt,
                    ).toLocaleString(),
                  },
                ]
              : []),
          ]}
        />
      </Card.Action>
    </Card.Header>
    <Card.Content>
      <dl class="grid gap-4 sm:grid-cols-2">
        <div class="min-w-0">
          <dt class="text-sm text-muted-foreground">Branch</dt>
          <dd class="truncate text-sm font-medium">
            {workspace.repository.currentBranch ?? "Detached or unborn HEAD"}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-sm text-muted-foreground">HEAD</dt>
          <dd class="truncate font-mono text-sm">
            {workspace.repository.headCommit?.slice(0, 12) ?? "No commit"}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-sm text-muted-foreground">Upstream</dt>
          <dd class="truncate text-sm font-medium">
            {syncStatusLabel(workspace.repository.syncStatus)}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-sm text-muted-foreground">Checked</dt>
          <dd class="truncate text-sm">
            {workspace.repository.checkedAt
              ? new Date(workspace.repository.checkedAt).toLocaleString()
              : "Not checked"}
          </dd>
        </div>
        <div class="min-w-0">
          <dt class="text-sm text-muted-foreground">Workspace slug</dt>
          <dd class="truncate font-mono text-sm">{workspace.slug}</dd>
        </div>
      </dl>
    </Card.Content>
    <Card.Footer
      class="flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      {#if workspace.repository.health === "healthy"}
        <Button disabled={syncing} onclick={onSync}>
          {#if syncing}<Spinner data-icon="inline-start" />{:else}<HugeiconsIcon
              icon={RefreshIcon}
              strokeWidth={2}
              data-icon="inline-start"
            />{/if}
          {syncing ? "Syncing…" : "Sync workspace"}
        </Button>
      {:else}
        <p class="text-sm text-muted-foreground">
          The record remains registered. Retry after restoring access, or remove
          only its Pi Dash metadata.
        </p>
        <Button disabled={refreshing} onclick={onRefresh}>
          {#if refreshing}<Spinner data-icon="inline-start" />{:else}<HugeiconsIcon
              icon={RefreshIcon}
              strokeWidth={2}
              data-icon="inline-start"
            />{/if}
          {refreshing ? "Checking…" : "Retry health check"}
        </Button>
      {/if}
    </Card.Footer>
  </Card.Root>

  <Separator />
  <WorktreeSection
    {workspace}
    {worktrees}
    loading={worktreeLoading}
    error={worktreeError}
    {reconciling}
    {onReconcile}
    onCreate={onCreateWorktree}
    onOpen={onOpenWorktree}
    onRemove={onRemoveWorktree}
    {onDeleteBranch}
  />
</section>
