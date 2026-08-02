<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { CodeView as CodeViewInstance } from "@pierre/diffs";

  export let patch: string;
  export let snapshotId: string;
  export let onError: (message: string) => void = () => undefined;

  let root: HTMLDivElement;
  let view: CodeViewInstance | undefined;
  let mounted = false;
  let renderedSnapshotId = "";
  let generation = 0;

  async function renderPatch(nextPatch: string, nextSnapshotId: string) {
    if (!mounted || !root || renderedSnapshotId === nextSnapshotId) return;
    const currentGeneration = ++generation;
    try {
      const { CodeView, parsePatchFiles } = await import("@pierre/diffs");
      if (!mounted || currentGeneration !== generation) return;
      const items = parsePatchFiles(nextPatch, nextSnapshotId, true).flatMap(
        (parsed, patchIndex) =>
          parsed.files.map((fileDiff, fileIndex) => ({
            id: `${patchIndex}:${fileIndex}:${fileDiff.name}`,
            type: "diff" as const,
            fileDiff,
            version: currentGeneration,
          })),
      );
      if (!view) {
        view = new CodeView({
          diffStyle: "unified",
          theme: "pierre-dark",
          themeType: "dark",
          overflow: "scroll",
          stickyHeaders: true,
          lineDiffType: "word-alt",
          maxLineDiffLength: 2_000,
          tokenizeMaxLineLength: 2_000,
        });
        view.setup(root);
      }
      view.setItems(items);
      renderedSnapshotId = nextSnapshotId;
      onError("");
    } catch (error) {
      if (mounted && currentGeneration === generation) {
        onError(
          error instanceof Error
            ? error.message
            : "The diff renderer could not display these changes.",
        );
      }
    }
  }

  $: if (mounted) void renderPatch(patch, snapshotId);

  onMount(() => {
    mounted = true;
    void renderPatch(patch, snapshotId);
  });

  onDestroy(() => {
    mounted = false;
    generation += 1;
    view?.cleanUp();
    view = undefined;
  });
</script>

<div
  bind:this={root}
  class="size-full min-h-0 overflow-auto bg-background"
  aria-label="Unified worktree diff"
></div>
