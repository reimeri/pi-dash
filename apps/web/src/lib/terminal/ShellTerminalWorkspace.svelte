<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import {
    ArrowReloadHorizontalIcon,
    PlayIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { TerminalControls } from "./controls.js";
  import TerminalPane from "./TerminalPane.svelte";

  export let worktree: WorktreeDto;
  export let workspaceName: string;
  export let maxFrameBytes: number;

  let controls: TerminalControls | undefined;

  function updateControls(
    worktreeId: string,
    next: TerminalControls | undefined,
  ): void {
    if (worktreeId === worktree.id) controls = next;
  }

  function startOrRestart(): void {
    if (!controls || controls.busy) return;
    if (
      controls.runtimeState === "stopped" ||
      controls.runtimeState === "crashed"
    ) {
      void controls.start();
    } else {
      void controls.restart();
    }
  }
</script>

<section
  id="worktree-shell-terminal"
  class="flex size-full min-h-0 flex-col bg-card"
  aria-labelledby="shell-terminal-title"
>
  <header class="flex items-start gap-3 border-b p-4 pr-3">
    <div class="min-w-0 flex-1">
      <h2 id="shell-terminal-title" class="truncate font-semibold">Terminal</h2>
    </div>
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={controls?.runtimeState === "stopped" ||
      controls?.runtimeState === "crashed"
        ? "Start shell terminal"
        : "Restart shell terminal"}
      title={controls?.runtimeState === "stopped" ||
      controls?.runtimeState === "crashed"
        ? "Start shell terminal"
        : "Restart shell terminal"}
      disabled={!controls || controls.busy}
      onclick={startOrRestart}
    >
      {#if controls?.busy}
        <Spinner data-icon="inline-start" />
      {:else if controls?.runtimeState === "stopped" || controls?.runtimeState === "crashed"}
        <HugeiconsIcon
          icon={PlayIcon}
          strokeWidth={2}
          data-icon="inline-start"
        />
      {:else}
        <HugeiconsIcon
          icon={ArrowReloadHorizontalIcon}
          strokeWidth={2}
          data-icon="inline-start"
        />
      {/if}
    </Button>
  </header>

  <div class="min-h-0 flex-1">
    <TerminalPane
      {worktree}
      {workspaceName}
      kind="shell"
      visible={true}
      {maxFrameBytes}
      onControlsChange={updateControls}
    />
  </div>
</section>
