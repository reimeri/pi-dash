<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import { AlertCircleIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import * as Sidebar from "$lib/components/ui/sidebar";
  import { cn } from "$lib/utils";
  import type { TerminalControls } from "../terminal/controls.js";
  import LazyTerminalWorkspace from "../terminal/LazyTerminalWorkspace.svelte";

  export let terminalOpen: boolean;
  export let selectedWorktree: WorktreeDto | undefined;
  export let workspaceName: string;
  export let terminalCacheSize: number;
  export let terminalMaxFrameBytes: number;
  export let liveTerminalWorktreeIds: string[];
  export let workspaceActionError: string;
  export let mainContent: HTMLDivElement | null = null;
  export let onControlsChange: (controls: TerminalControls | undefined) => void;
  export let onAcknowledge: (worktreeId: string) => void;
  export let onDismissError: () => void;
</script>

<div
  id="main-content"
  bind:this={mainContent}
  tabindex="-1"
  data-testid="dashboard-shell"
  class={cn(
    "relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-background",
    terminalOpen ? "overflow-hidden p-0" : "p-6 md:p-10 lg:p-12",
  )}
>
  <div class="absolute left-4 top-4 z-10 md:hidden">
    <Sidebar.Trigger />
  </div>
  <LazyTerminalWorkspace
    selected={terminalOpen ? selectedWorktree : undefined}
    {workspaceName}
    cacheSize={terminalCacheSize}
    maxFrameBytes={terminalMaxFrameBytes}
    {liveTerminalWorktreeIds}
    {onControlsChange}
    {onAcknowledge}
  />

  {#if workspaceActionError}
    <Alert.Root
      variant="destructive"
      class="absolute right-4 top-4 z-10 max-w-md"
      role="alert"
    >
      <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
      <Alert.Title>Unable to complete action</Alert.Title>
      <Alert.Description>{workspaceActionError}</Alert.Description>
      <Alert.Action>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss error"
          onclick={onDismissError}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </Alert.Action>
    </Alert.Root>
  {/if}

  {#if !terminalOpen}
    <slot />
  {/if}
</div>
