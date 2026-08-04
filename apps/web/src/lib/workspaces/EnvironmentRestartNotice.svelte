<script lang="ts">
  import type {
    ShellActivityDto,
    WorkspaceDto,
    WorkspaceEnvironmentChangeDto,
    WorktreeDto,
  } from "@pi-dash/contracts";
  import {
    AlertCircleIcon,
    ArrowReloadHorizontalIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";

  export let changes: WorkspaceEnvironmentChangeDto[];
  export let workspaces: WorkspaceDto[];
  export let worktreesByWorkspace: Record<string, WorktreeDto[]>;
  export let shellActivities: Record<string, ShellActivityDto>;
  export let restarting: boolean;
  export let onRestart: () => Promise<boolean>;

  let confirmationOpen = false;

  $: affected = changes.flatMap((change) =>
    change.affectedRuntimes.map((runtime) => ({
      ...runtime,
      workspaceId: change.workspaceId,
    })),
  );
  $: activeShellCount = affected.filter(
    (runtime) =>
      runtime.kind === "shell" &&
      shellActivities[runtime.worktreeId]?.foregroundCommandActive,
  ).length;
  $: affectedWorkspaceNames = changes.map(
    (change) =>
      workspaces.find((workspace) => workspace.id === change.workspaceId)
        ?.name ?? "Unknown workspace",
  );
  $: affectedLabels = affected.map((runtime) => {
    const worktree = worktreesByWorkspace[runtime.workspaceId]?.find(
      (candidate) => candidate.id === runtime.worktreeId,
    );
    return {
      key: `${runtime.workspaceId}:${runtime.worktreeId}:${runtime.kind}`,
      label: `${worktree?.name ?? "Managed worktree"} (${runtime.kind === "pi" ? "Pi" : "shell"})`,
    };
  });

  async function restart(): Promise<void> {
    if (await onRestart()) confirmationOpen = false;
  }
</script>

{#if affected.length > 0}
  <Alert.Root class="rounded-none border-x-0 border-t-0" role="status">
    <HugeiconsIcon icon={ArrowReloadHorizontalIcon} strokeWidth={2} />
    <Alert.Title>Workspace environment changed</Alert.Title>
    <Alert.Description>
      {affected.length} running {affected.length === 1
        ? "runtime is"
        : "runtimes are"}
      using older variables in {affectedWorkspaceNames.join(", ")}.
    </Alert.Description>
    <Alert.Action>
      <Button
        variant="outline"
        size="sm"
        disabled={restarting}
        onclick={() => (confirmationOpen = true)}
      >
        {#if restarting}
          <Spinner data-icon="inline-start" />
        {:else}
          <HugeiconsIcon
            icon={ArrowReloadHorizontalIcon}
            strokeWidth={2}
            data-icon="inline-start"
          />
        {/if}
        {restarting ? "Restarting…" : "Restart affected"}
      </Button>
    </Alert.Action>
  </Alert.Root>

  <AlertDialog.Root bind:open={confirmationOpen}>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Media>
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
        </AlertDialog.Media>
        <AlertDialog.Title>Restart affected runtimes?</AlertDialog.Title>
        <AlertDialog.Description>
          This stops the current processes and starts fresh terminals with the
          updated workspace environment.
        </AlertDialog.Description>
      </AlertDialog.Header>

      <ul
        class="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground"
      >
        {#each affectedLabels as item (item.key)}
          <li>{item.label}</li>
        {/each}
      </ul>

      {#if activeShellCount > 0}
        <Alert.Root variant="destructive">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <Alert.Title>Active shell commands will stop</Alert.Title>
          <Alert.Description>
            {activeShellCount} affected {activeShellCount === 1
              ? "shell has"
              : "shells have"} a foreground command.
          </Alert.Description>
        </Alert.Root>
      {/if}

      <AlertDialog.Footer>
        <AlertDialog.Cancel disabled={restarting}>Cancel</AlertDialog.Cancel>
        <Button disabled={restarting} onclick={() => void restart()}>
          {#if restarting}<Spinner data-icon="inline-start" />{/if}
          {restarting ? "Restarting…" : "Restart runtimes"}
        </Button>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>
{/if}
