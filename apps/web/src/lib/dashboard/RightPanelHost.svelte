<script lang="ts">
  import type { WorktreeDto } from "@pi-dash/contracts";
  import * as Resizable from "$lib/components/ui/resizable";
  import * as Sheet from "$lib/components/ui/sheet";
  import DiffWorkspace from "../diff/DiffWorkspace.svelte";
  import type { WorktreeDiffState } from "../diff/store.js";
  import LazyShellTerminalWorkspace from "../terminal/LazyShellTerminalWorkspace.svelte";

  export let surface: "desktop" | "mobile";
  export let terminalOpen: boolean;
  export let rightPanel: "none" | "diff" | "shell";
  export let selectedWorktree: WorktreeDto | undefined;
  export let workspaceName: string;
  export let terminalMaxFrameBytes: number;
  export let diffState: WorktreeDiffState;
  export let onRefreshDiff: () => void;
  export let onCloseShell: () => void;
  export let onClosePanel: () => void;

  $: desktopOpen =
    surface === "desktop" &&
    terminalOpen &&
    rightPanel !== "none" &&
    !!selectedWorktree;
  $: mobileOpen = surface === "mobile" && terminalOpen && !!selectedWorktree;
</script>

{#if desktopOpen && selectedWorktree}
  <Resizable.Handle withHandle />
  <Resizable.Pane
    class="min-h-0"
    defaultSize={45}
    minSize={30}
    maxSize={70}
    order={2}
  >
    {#if rightPanel === "diff"}
      <DiffWorkspace
        worktree={selectedWorktree}
        state={diffState}
        onRefresh={onRefreshDiff}
      />
    {:else}
      <LazyShellTerminalWorkspace
        worktree={selectedWorktree}
        {workspaceName}
        maxFrameBytes={terminalMaxFrameBytes}
      />
    {/if}
  </Resizable.Pane>
{:else if mobileOpen && selectedWorktree}
  <Sheet.Root
    open={rightPanel !== "none"}
    onOpenChange={(open) => {
      if (!open) {
        if (rightPanel === "shell") onCloseShell();
        else onClosePanel();
      }
    }}
  >
    <Sheet.Content
      side="right"
      showCloseButton={false}
      class="w-[calc(100%-1rem)] p-0"
    >
      <Sheet.Header class="sr-only">
        <Sheet.Title>
          {rightPanel === "diff" ? "Worktree changes" : "Shell terminal"}
        </Sheet.Title>
        <Sheet.Description>
          {rightPanel === "diff"
            ? "Unified diff against the selected worktree branch’s newest commit."
            : "Interactive shell in the selected managed worktree."}
        </Sheet.Description>
      </Sheet.Header>
      {#if rightPanel === "diff"}
        <DiffWorkspace
          worktree={selectedWorktree}
          state={diffState}
          onRefresh={onRefreshDiff}
        />
      {:else if rightPanel === "shell"}
        <LazyShellTerminalWorkspace
          worktree={selectedWorktree}
          {workspaceName}
          maxFrameBytes={terminalMaxFrameBytes}
        />
      {/if}
    </Sheet.Content>
  </Sheet.Root>
{/if}
