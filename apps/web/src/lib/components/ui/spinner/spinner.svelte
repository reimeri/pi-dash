<script lang="ts">
  import { Loading03Icon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { cn } from "$lib/utils.js";

  type SpinnerProps = {
    class?: string;
    role?: string;
    "aria-label"?: string;
    "aria-hidden"?: boolean | "true" | "false";
    "data-icon"?: "inline-start" | "inline-end";
  };

  let {
    class: className,
    role = "status",
    "aria-label": ariaLabel = "Loading",
    "aria-hidden": ariaHidden,
    "data-icon": dataIcon,
  }: SpinnerProps = $props();
</script>

<HugeiconsIcon
  icon={Loading03Icon}
  strokeWidth={2}
  {role}
  aria-label={ariaLabel}
  aria-hidden={ariaHidden}
  data-icon={dataIcon}
  data-slot="spinner"
  class={cn("size-4 animate-spin motion-reduce:animate-none", className)}
/>
