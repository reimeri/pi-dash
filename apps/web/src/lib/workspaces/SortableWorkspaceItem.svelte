<script lang="ts">
  import type { Snippet } from "svelte";
  import { createSortable } from "@dnd-kit/svelte/sortable";
  import * as Sidebar from "$lib/components/ui/sidebar";
  import { cn } from "$lib/utils";

  interface Props {
    id: string;
    index: number;
    children: Snippet;
  }

  let { id, index, children }: Props = $props();
  let element = $state<HTMLLIElement | null>(null);
  const sortable = createSortable({
    get id() {
      return id;
    },
    get index() {
      return index;
    },
    plugins: [],
    transition: { duration: 150, easing: "ease-out" },
  });

  $effect(() => {
    if (!element) return;
    const source = element.querySelector<HTMLElement>(
      "[data-workspace-drag-source]",
    );
    if (!source) return;
    const detachTarget = sortable.attachTarget(element);
    const detachSource = sortable.attachSource(source);
    return () => {
      detachSource();
      detachTarget();
    };
  });
</script>

<Sidebar.MenuItem
  bind:ref={element}
  data-workspace-id={id}
  data-dragging={sortable.isDragging ? "true" : undefined}
  class={cn(
    "transition-[opacity,transform] motion-reduce:transition-none",
    sortable.isDragging && "opacity-60 ring-1 ring-sidebar-ring",
  )}
>
  {@render children()}
</Sidebar.MenuItem>
