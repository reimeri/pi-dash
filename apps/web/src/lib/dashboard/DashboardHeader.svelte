<script lang="ts">
  import type { WorkflowStatusDto } from "@pi-dash/contracts";
  import {
    ArrowReloadHorizontalIcon,
    CheckmarkCircle02Icon,
    ComputerTerminal01Icon,
    PlayIcon,
    PlusMinus01Icon,
    StopIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Popover from "$lib/components/ui/popover";
  import { Separator } from "$lib/components/ui/separator";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { WorktreeDiffState } from "../diff/store.js";
  import type { TerminalControls } from "../terminal/controls.js";

  export let diffAvailable: boolean;
  export let terminalOpen: boolean;
  export let rightPanel: "none" | "diff" | "shell";
  export let diffState: WorktreeDiffState;
  export let terminalControls: TerminalControls | undefined;
  export let selectedWorkflowStatus: WorkflowStatusDto | undefined;
  export let selectedWorktreeId: string | undefined;
  export let shellActivityPending: boolean;
  export let terminalMenuOpen = false;
  export let shellTrigger: HTMLButtonElement | null = null;
  export let onTogglePanel: (panel: "diff" | "shell") => void;
  export let onAcknowledge: (worktreeId: string, explicit: boolean) => void;
  export let onTerminalMenuCloseAutoFocus: (event: Event) => void;

  function diffButtonLabel(state: WorktreeDiffState): string {
    if (state.status === "loading" && !state.summary) return "Checking changes";
    if (state.status === "error" && !state.summary) {
      return "View changes; the latest change count is unavailable";
    }
    const summary = state.summary;
    if (!summary?.hasChanges) return "View changes: no changes";
    return `View changes: ${summary.additions} added lines, ${summary.deletions} deleted lines across ${summary.filesChanged} ${summary.filesChanged === 1 ? "file" : "files"}`;
  }

  function terminalInputStatus(controls: TerminalControls | undefined): string {
    if (!controls || controls.socketState === "connecting") return "Connecting";
    if (controls.socketState === "disconnected") return "Disconnected";
    if (!controls.inputOwnerKnown) return "Negotiating";
    return controls.inputOwner ? "Interactive" : "Observer only";
  }
</script>

<header class="flex h-13 items-center justify-between border-b bg-card px-4">
  <div
    class="flex items-center gap-2 text-sm font-medium"
    aria-label="Pi Dash home"
  >
    <span
      class="flex size-7 items-center justify-center rounded-lg border bg-background"
      aria-hidden="true">π</span
    >
  </div>
  <div class="flex min-w-0 items-center gap-2">
    {#if diffAvailable}
      <Button
        variant={rightPanel === "diff" ? "secondary" : "outline"}
        size={diffState.summary?.hasChanges ? "sm" : "icon-sm"}
        aria-label={diffButtonLabel(diffState)}
        aria-expanded={rightPanel === "diff"}
        aria-controls="worktree-diff-viewer"
        title={diffButtonLabel(diffState)}
        onclick={() => onTogglePanel("diff")}
      >
        {#if diffState.status === "loading" && !diffState.summary}
          <Spinner />
        {:else if diffState.summary?.hasChanges}
          <span class="text-diff-addition">+{diffState.summary.additions}</span>
          <span class="text-diff-deletion">−{diffState.summary.deletions}</span>
        {:else}
          <HugeiconsIcon icon={PlusMinus01Icon} strokeWidth={2} />
        {/if}
      </Button>
    {/if}
    {#if terminalOpen}
      <Button
        bind:ref={shellTrigger}
        variant={rightPanel === "shell" ? "secondary" : "outline"}
        size="icon-sm"
        class="relative"
        aria-label={rightPanel === "shell"
          ? "Close shell terminal"
          : "Open shell terminal"}
        aria-expanded={rightPanel === "shell"}
        aria-controls="worktree-shell-terminal"
        title={rightPanel === "shell"
          ? "Close shell terminal"
          : "Open shell terminal"}
        onclick={() => onTogglePanel("shell")}
      >
        <HugeiconsIcon
          icon={ComputerTerminal01Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />
        {#if shellActivityPending}
          <span
            class="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
            aria-hidden="true"
          ></span>
        {/if}
      </Button>
      <Popover.Root bind:open={terminalMenuOpen}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="sm"
              aria-label="Terminal"
            >
              Status
            </Button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content
          align="end"
          class="w-80"
          aria-label="Terminal controls"
          onCloseAutoFocus={onTerminalMenuCloseAutoFocus}
        >
          <Popover.Header>
            <Popover.Title>Pi terminal status</Popover.Title>
          </Popover.Header>
          <div class="flex flex-col gap-3" aria-live="polite">
            <div class="grid grid-cols-2 gap-2 text-sm">
              <span class="text-muted-foreground">Runtime</span>
              <Badge
                variant={terminalControls?.runtimeState === "running"
                  ? "secondary"
                  : terminalControls?.runtimeState === "crashed"
                    ? "destructive"
                    : "outline"}
              >
                {terminalControls?.runtimeState ?? "starting"}
              </Badge>
              <span class="text-muted-foreground">Socket</span>
              <Badge
                variant={terminalControls?.socketState === "connected"
                  ? "secondary"
                  : terminalControls?.socketState === "disconnected"
                    ? "destructive"
                    : "outline"}
              >
                {terminalControls?.socketState ?? "connecting"}
              </Badge>
              <span class="text-muted-foreground">Input</span>
              <Badge variant="secondary">
                {terminalInputStatus(terminalControls)}
              </Badge>
              <span class="text-muted-foreground">Workflow</span>
              <Badge variant="secondary">
                {selectedWorkflowStatus?.state ?? "idle"}
              </Badge>
            </div>
            <Separator />
            <div class="flex flex-wrap gap-2">
              {#if terminalControls?.runtimeState === "stopped" || terminalControls?.runtimeState === "crashed"}
                <Button
                  size="sm"
                  disabled={terminalControls.busy}
                  onclick={() => terminalControls?.start()}
                >
                  {#if terminalControls.busy}<Spinner
                      data-icon="inline-start"
                    />{:else}<HugeiconsIcon
                      icon={PlayIcon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />{/if}
                  {terminalControls.busy ? "Starting…" : "Start"}
                </Button>
              {:else}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!terminalControls || terminalControls.busy}
                  onclick={() => terminalControls?.stop()}
                >
                  {#if terminalControls?.busy}<Spinner
                      data-icon="inline-start"
                    />{:else}<HugeiconsIcon
                      icon={StopIcon}
                      strokeWidth={2}
                      data-icon="inline-start"
                    />{/if}
                  {terminalControls?.busy ? "Stopping…" : "Stop"}
                </Button>
              {/if}
              <Button
                variant="outline"
                size="sm"
                disabled={!terminalControls || terminalControls.busy}
                onclick={() => terminalControls?.restart()}
              >
                <HugeiconsIcon
                  icon={ArrowReloadHorizontalIcon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                Restart
              </Button>
              {#if selectedWorkflowStatus?.state === "done" && selectedWorktreeId}
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => onAcknowledge(selectedWorktreeId!, true)}
                >
                  <HugeiconsIcon
                    icon={CheckmarkCircle02Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                  />
                  Acknowledge done
                </Button>
              {/if}
            </div>
          </div>
        </Popover.Content>
      </Popover.Root>
    {/if}
  </div>
</header>
