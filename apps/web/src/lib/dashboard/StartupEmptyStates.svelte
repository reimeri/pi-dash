<script lang="ts">
  import {
    AlertCircleIcon,
    ExternalLinkIcon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import * as Empty from "$lib/components/ui/empty";
  import { Spinner } from "$lib/components/ui/spinner";
  import type { StartupState } from "../../connection.js";

  export let startup: StartupState;
</script>

{#if startup.status === "unauthorized"}
  <Empty.Root class="mx-auto h-full max-w-lg">
    <Empty.Header>
      <Empty.Media variant="icon"
        ><HugeiconsIcon icon={ExternalLinkIcon} strokeWidth={2} /></Empty.Media
      >
      <Empty.Title role="heading" aria-level={2}
        >Authenticate with Pi Dash</Empty.Title
      >
      <Empty.Description
        >Open a fresh local launch link, or verify that your current Tailscale
        identity is allowed to access this Pi Dash instance.</Empty.Description
      >
    </Empty.Header>
  </Empty.Root>
{:else if startup.status === "connecting"}
  <Empty.Root class="mx-auto h-full max-w-lg">
    <Empty.Header>
      <Empty.Media variant="icon"><Spinner /></Empty.Media>
      <Empty.Title role="heading" aria-level={2}
        >Connecting to Pi Dash</Empty.Title
      >
      <Empty.Description
        >Pi Dash is checking its database and secure browser session.</Empty.Description
      >
    </Empty.Header>
  </Empty.Root>
{:else if startup.status === "disconnected" || startup.status === "migration-failed"}
  <Empty.Root class="mx-auto h-full max-w-lg">
    <Empty.Header>
      <Empty.Media variant="icon"
        ><HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} /></Empty.Media
      >
      <Empty.Title role="heading" aria-level={2}
        >{startup.status === "migration-failed"
          ? "Database setup failed"
          : "The local daemon is disconnected"}</Empty.Title
      >
      <Empty.Description
        >Use the diagnostic above to recover without changing repository files.</Empty.Description
      >
    </Empty.Header>
  </Empty.Root>
{/if}
