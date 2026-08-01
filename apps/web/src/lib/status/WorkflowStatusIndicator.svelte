<script lang="ts">
  import type {
    StatusIntegration,
    WorkflowState,
    WorkflowStatusDto,
  } from "@pi-dash/contracts";

  export let status: WorkflowStatusDto | undefined = undefined;
  export let stateOverride: WorkflowState | undefined = undefined;
  export let integrationOverride: StatusIntegration | undefined = undefined;
  export let labelPrefix = "Workflow";
  export let aggregateCount: number | undefined = undefined;
  export let channel: "connecting" | "connected" | "disconnected" =
    "connecting";

  $: state = stateOverride ?? status?.state ?? ("idle" as WorkflowState);
  $: integration =
    integrationOverride ?? status?.integration ?? ("disconnected" as const);
  $: label = statusLabel(state, integration);
  $: channelDetail =
    channel === "connected" ? "" : `; status channel ${channel}`;
  $: detail =
    aggregateCount === undefined
      ? `${labelPrefix}: ${label}${status ? `; changed ${new Date(status.changedAt).toLocaleString()}` : ""}${channelDetail}`
      : `${labelPrefix}: ${label}; ${aggregateCount} worktree${aggregateCount === 1 ? "" : "s"} need attention${channelDetail}`;

  function statusLabel(
    workflow: WorkflowState,
    health: StatusIntegration,
  ): string {
    const stateLabel = {
      idle: "Idle",
      working: "Working",
      blocked: "Blocked waiting for an answer",
      done: "Done, acknowledgement required",
    }[workflow];
    return health === "connected"
      ? stateLabel
      : `${stateLabel}; status integration ${health}`;
  }
</script>

<span
  class={`workflow-indicator workflow-${state} integration-${integration}`}
  title={detail}
  aria-label={detail}
  role="img"
>
  <span class="workflow-glyph" aria-hidden="true">
    {state === "done" ? "✓" : state === "blocked" ? "!" : ""}
  </span>
  <span class="sr-only">{detail}</span>
</span>
