<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import type { HealthIssue } from "./health.js";

  export let label: string;
  export let subject: "Repository" | "Worktree";
  export let issue: HealthIssue | undefined;
  export let details: { label: string; value: string }[] = [];
  export let lastError:
    | {
        code: string;
        message: string;
      }
    | undefined = undefined;
</script>

{#if issue}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Badge
          {...props}
          tabindex={0}
          variant="destructive"
          aria-label={`${subject} health: ${issue.title}`}
        >
          {label}
        </Badge>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="bottom" align="end" class="max-w-sm items-start">
      <div class="flex flex-col gap-2">
        <div>
          <p class="font-medium">{issue.title}</p>
          <p class="mt-0.5">{issue.description}</p>
        </div>
        {#if details.length > 0}
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
            {#each details as detail (detail.label)}
              <dt class="font-medium">{detail.label}</dt>
              <dd class="break-all font-mono">{detail.value}</dd>
            {/each}
          </dl>
        {/if}
        {#if lastError}
          <div class="flex flex-col gap-0.5">
            <p class="font-medium">
              Last error · <code>{lastError.code}</code>
            </p>
            <p>{lastError.message}</p>
          </div>
        {/if}
      </div>
    </Tooltip.Content>
  </Tooltip.Root>
{:else}
  <Badge variant="secondary">{label}</Badge>
{/if}
