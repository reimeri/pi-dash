<script lang="ts">
  import { Add01Icon, FolderGitIcon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Empty from "$lib/components/ui/empty";

  export let hasWorkspaces: boolean;
  export let onAdd: () => void;
</script>

<Empty.Root class="mx-auto h-full max-w-lg">
  <Empty.Header>
    <Empty.Media variant="icon"
      ><HugeiconsIcon icon={FolderGitIcon} strokeWidth={2} /></Empty.Media
    >
    <Empty.Title role="heading" aria-level={2}
      >{hasWorkspaces
        ? "Select a workspace"
        : "Add a workspace to get started"}</Empty.Title
    >
    <Empty.Description>
      {hasWorkspaces
        ? "Choose a workspace for repository details, or expand it to open a managed worktree terminal."
        : "Register an existing Git repository. Pi Dash validates it without modifying repository contents."}
    </Empty.Description>
  </Empty.Header>
  {#if !hasWorkspaces}
    <Empty.Content
      ><Button onclick={onAdd}
        ><HugeiconsIcon
          icon={Add01Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />Add workspace</Button
      ></Empty.Content
    >
  {/if}
</Empty.Root>
