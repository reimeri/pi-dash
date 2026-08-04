<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import {
    AlertCircleIcon,
    ArrowReloadHorizontalIcon,
    ArrowRight01Icon,
    ComputerTerminal01Icon,
    Delete02Icon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { cn } from "$lib/utils.js";
  import HealthBadge from "../workspaces/HealthBadge.svelte";
  import { displayPath } from "../workspaces/display.js";
  import { healthLabel, worktreeHealthIssue } from "../workspaces/health.js";
  import { canOpenTerminal } from "./terminal-access.js";

  export let worktree: WorktreeDto;
  export let onOpen: (worktree: WorktreeDto) => void;
  export let onRemove: (worktree: WorktreeDto) => void;
  export let onDeleteBranch: (worktree: WorktreeDto) => void;
  export let onReconcile: () => void;

  let expanded = false;

  $: worktreeIssue = worktreeHealthIssue(worktree.health, worktree.lifecycle);
  $: branchLabel = worktree.branchRef.replace(/^refs\/heads\//, "");
  $: detailsId = `worktree-details-${worktree.id}`;
  $: dirtyLabel =
    worktree.dirty === true
      ? "Dirty"
      : worktree.dirty === false
        ? "Clean"
        : "Unknown";
</script>

<Collapsible.Root bind:open={expanded}>
  <Card.Root
    role="article"
    size="sm"
    aria-label={worktree.name}
    data-testid="worktree-card"
    data-worktree-id={worktree.id}
  >
    <div class="flex flex-col">
      <div class="flex items-start gap-2 px-(--card-spacing)">
        <Collapsible.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${worktree.name} details`}
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                class={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  expanded && "rotate-90",
                )}
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium">{worktree.name}</span>
                <span
                  class="mt-0.5 flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
                >
                  <code class="truncate">{branchLabel}</code>
                  {#if worktree.dirty === true}
                    <Badge variant="outline" class="shrink-0">Dirty</Badge>
                  {/if}
                  {#if worktree.lifecycle !== "ready"}
                    <span class="shrink-0 capitalize">{worktree.lifecycle}</span
                    >
                  {/if}
                </span>
              </span>
            </button>
          {/snippet}
        </Collapsible.Trigger>

        <div class="flex shrink-0 items-center gap-1 pt-0.5">
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
          {#if worktree.lifecycle === "ready"}
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!canOpenTerminal(worktree)}
              aria-label="Open Pi"
              title={canOpenTerminal(worktree)
                ? "Open Pi terminal"
                : "Terminal unavailable until this worktree is healthy"}
              onclick={() => onOpen(worktree)}
            >
              <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={2} />
            </Button>
            <Button
              variant="destructive"
              size="icon-sm"
              aria-label="Remove worktree"
              title="Remove worktree"
              onclick={() => onRemove(worktree)}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </Button>
          {:else if worktree.lifecycle === "removed"}
            <Button
              variant="destructive"
              size="icon-sm"
              aria-label="Delete merged branch"
              title="Delete merged branch"
              onclick={() => onDeleteBranch(worktree)}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </Button>
          {:else}
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Inspect and reconcile"
              title="Inspect and reconcile"
              onclick={onReconcile}
            >
              <HugeiconsIcon icon={ArrowReloadHorizontalIcon} strokeWidth={2} />
            </Button>
          {/if}
        </div>
      </div>

      <Collapsible.Content id={detailsId}>
        <div
          class="mt-(--card-spacing) flex flex-col gap-3 border-t px-(--card-spacing) pt-(--card-spacing)"
        >
          <p
            data-testid="worktree-path"
            class="break-all font-mono text-xs text-muted-foreground"
          >
            {displayPath(worktree.path)}
          </p>
          <dl class="grid grid-cols-2 gap-3">
            <div>
              <dt class="text-xs text-muted-foreground">Base</dt>
              <dd class="font-mono text-sm">
                {worktree.baseCommit.slice(0, 12)}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">Changes</dt>
              <dd class="text-sm">{dirtyLabel}</dd>
            </div>
          </dl>
          {#if worktree.lastError}
            <Alert.Root variant="destructive" role="status"
              ><HugeiconsIcon
                icon={AlertCircleIcon}
                strokeWidth={2}
              /><Alert.Title>{worktree.lastError.code}</Alert.Title
              ><Alert.Description
                >{worktree.lastError.message}</Alert.Description
              ></Alert.Root
            >
          {/if}
        </div>
      </Collapsible.Content>
    </div>
  </Card.Root>
</Collapsible.Root>
