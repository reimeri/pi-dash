<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import {
    AlertCircleIcon,
    ArrowReloadHorizontalIcon,
    ComputerTerminal01Icon,
    Delete02Icon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import HealthBadge from "../workspaces/HealthBadge.svelte";
  import { displayPath } from "../workspaces/display.js";
  import { healthLabel, worktreeHealthIssue } from "../workspaces/health.js";
  import { canOpenTerminal } from "./terminal-access.js";

  export let worktree: WorktreeDto;
  export let onOpen: (worktree: WorktreeDto) => void;
  export let onRemove: (worktree: WorktreeDto) => void;
  export let onDeleteBranch: (worktree: WorktreeDto) => void;
  export let onReconcile: () => void;

  $: worktreeIssue = worktreeHealthIssue(worktree.health, worktree.lifecycle);
</script>

<Card.Root
  role="article"
  aria-label={worktree.name}
  data-testid="worktree-card"
  data-worktree-id={worktree.id}
>
  <Card.Header>
    <div class="min-w-0">
      <Card.Title>{worktree.name}</Card.Title>
      <Card.Description>{worktree.lifecycle}</Card.Description>
    </div>
    <Card.Action>
      <HealthBadge
        label={healthLabel(worktree.health)}
        subject="Worktree"
        issue={worktreeIssue}
        details={[
          {
            label: "Path",
            value: displayPath(worktree.path),
          },
          {
            label: "Lifecycle",
            value: worktree.lifecycle,
          },
        ]}
        lastError={worktree.lastError}
      />
    </Card.Action>
  </Card.Header>
  <Card.Content class="flex flex-col gap-3">
    <code class="truncate text-sm">{worktree.branchRef}</code>
    <p
      data-testid="worktree-path"
      class="break-all font-mono text-xs text-muted-foreground"
    >
      {displayPath(worktree.path)}
    </p>
    <dl class="grid grid-cols-2 gap-3">
      <div>
        <dt class="text-xs text-muted-foreground">Base</dt>
        <dd class="font-mono text-sm">{worktree.baseCommit.slice(0, 12)}</dd>
      </div>
      <div>
        <dt class="text-xs text-muted-foreground">Changes</dt>
        <dd class="text-sm">
          {worktree.dirty === true
            ? "Dirty"
            : worktree.dirty === false
              ? "Clean"
              : "Unknown"}
        </dd>
      </div>
    </dl>
    {#if worktree.lastError}
      <Alert.Root variant="destructive" role="status"
        ><HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} /><Alert.Title
          >{worktree.lastError.code}</Alert.Title
        ><Alert.Description>{worktree.lastError.message}</Alert.Description
        ></Alert.Root
      >
    {/if}
  </Card.Content>
  <Card.Footer class="flex-wrap gap-2">
    {#if worktree.lifecycle === "ready"}
      <Button
        disabled={!canOpenTerminal(worktree)}
        title={canOpenTerminal(worktree)
          ? "Open Pi terminal"
          : "Terminal unavailable until this worktree is healthy"}
        onclick={() => onOpen(worktree)}
      >
        <HugeiconsIcon
          icon={ComputerTerminal01Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />Open Pi
      </Button>
      <Button
        variant="destructive"
        class="ml-auto"
        onclick={() => onRemove(worktree)}
      >
        <HugeiconsIcon
          icon={Delete02Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />Remove
      </Button>
    {:else if worktree.lifecycle === "removed"}
      <Button variant="destructive" onclick={() => onDeleteBranch(worktree)}>
        <HugeiconsIcon
          icon={Delete02Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />Delete merged branch
      </Button>
    {:else}
      <Button variant="outline" onclick={onReconcile}>
        <HugeiconsIcon
          icon={ArrowReloadHorizontalIcon}
          strokeWidth={2}
          data-icon="inline-start"
        />Inspect and reconcile
      </Button>
    {/if}
  </Card.Footer>
</Card.Root>
