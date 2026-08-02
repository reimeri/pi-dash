<script lang="ts">
  import { Add01Icon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Sidebar from "$lib/components/ui/sidebar";

  export let disabled = false;
  export let onAdd: () => void;

  const sidebar = Sidebar.useSidebar();

  function addWorkspace(): void {
    if (sidebar.isMobile) sidebar.setOpenMobile(false);
    onAdd();
  }
</script>

<Button
  size="icon-sm"
  variant="ghost"
  class="w-full"
  {disabled}
  aria-label="Add workspace"
  onclick={addWorkspace}
>
  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} aria-hidden="true" />
</Button>
