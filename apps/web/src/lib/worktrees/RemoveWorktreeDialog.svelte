<script lang="ts">
  import {
    WorktreeRemovalInspectionSchema,
    type RemoveWorktreeResponse,
    type WorktreeDto,
    type WorktreeRemovalInspection,
  } from "@pi-dash/contracts";
  import { Value } from "@sinclair/typebox/value";
  import {
    AlertCircleIcon,
    ArrowLeft01Icon,
    Delete02Icon,
  } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onMount } from "svelte";
  import * as Alert from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import * as Field from "$lib/components/ui/field";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import { ApiClientError, api } from "../../api.js";

  export let worktree: WorktreeDto;
  export let fallbackFocus: HTMLElement | null = null;
  export let onClose: () => void;
  export let onRemoved: (result: RemoveWorktreeResponse) => void;

  let inspection: WorktreeRemovalInspection | undefined;
  let result: RemoveWorktreeResponse | undefined;
  let loading = true;
  let removing = false;
  let reviewingForce = false;
  let detailsOpen = false;
  let confirmation = "";
  let error = "";
  let operationId = crypto.randomUUID();
  let dialogOpen = true;
  let returnFocus: HTMLElement | null = null;

  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void prepare();
  });

  function restoreFocus(): void {
    requestAnimationFrame(() => {
      const target = returnFocus?.isConnected ? returnFocus : fallbackFocus;
      if (target?.isConnected) target.focus();
    });
  }

  function close() {
    if (removing) return;
    onClose();
    restoreFocus();
  }

  function finish(
    resultToApply: RemoveWorktreeResponse | undefined = undefined,
  ): void {
    if (resultToApply) onRemoved(resultToApply);
    onClose();
    restoreFocus();
  }

  function inspectionFromError(caught: ApiClientError) {
    const details = caught.envelope?.error.details;
    return Value.Check(WorktreeRemovalInspectionSchema, details)
      ? details
      : undefined;
  }

  function statusParts(current: WorktreeRemovalInspection): {
    status: string;
    removal: string;
    branch: string;
  } {
    return {
      status: !current.dirty.available
        ? "Unknown"
        : current.dirty.dirty
          ? "Has local changes"
          : "Clean",
      removal:
        current.removalStrategy === "git"
          ? current.observed.locked
            ? "Git removal with lock override"
            : "Git removal"
          : "Filesystem only",
      branch:
        current.branchDisposition.kind === "manual"
          ? "Left alone"
          : "Kept for cleanup",
    };
  }

  async function prepare(): Promise<void> {
    loading = true;
    error = "";
    reviewingForce = false;
    detailsOpen = false;
    confirmation = "";
    try {
      inspection = await api.prepareWorktreeRemoval(worktree.id);
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to inspect worktree.";
    } finally {
      loading = false;
    }
  }

  async function remove(mode: "safe" | "force"): Promise<void> {
    if (!inspection || (mode === "force" && confirmation !== "delete")) return;
    removing = true;
    error = "";
    try {
      const response = await api.removeWorktree(
        worktree.id,
        mode === "safe"
          ? {
              mode: "safe",
              confirmationToken: inspection.confirmationToken,
            }
          : {
              mode: "force",
              confirmationToken: inspection.confirmationToken,
              confirmation: "delete",
            },
        operationId,
      );
      if (mode === "force" || response.warnings.length > 0) {
        result = response;
      } else {
        finish(response);
      }
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        const changed = inspectionFromError(caught);
        if (changed) {
          inspection = changed;
          reviewingForce = false;
          confirmation = "";
        }
        if (caught.envelope?.error.code !== "OPERATION_IN_PROGRESS") {
          operationId = crypto.randomUUID();
        }
      }
      error =
        caught instanceof Error ? caught.message : "Unable to remove worktree.";
    } finally {
      removing = false;
    }
  }
</script>

<AlertDialog.Root bind:open={dialogOpen}>
  <AlertDialog.Content
    class="max-h-[calc(100dvh-2rem)] overflow-y-auto"
    onEscapeKeydown={(event) => {
      event.preventDefault();
      if (!removing) close();
    }}
    onInteractOutside={(event) => {
      event.preventDefault();
      if (!removing) close();
    }}
  >
    <p class="sr-only" role="status" aria-live="polite">
      {loading
        ? "Inspecting managed worktree"
        : removing
          ? "Removing managed worktree"
          : ""}
    </p>

    {#if result}
      <AlertDialog.Header>
        <AlertDialog.Media>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </AlertDialog.Media>
        <AlertDialog.Title>Worktree removed</AlertDialog.Title>
        <AlertDialog.Description>
          {result.outcome === "forgotten"
            ? "The allocated path was removed and the Pi Dash record was forgotten."
            : "The allocated path was removed and branch cleanup remains available."}
        </AlertDialog.Description>
      </AlertDialog.Header>
      {#if result.warnings.length > 0}
        <Alert.Root variant="destructive">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <Alert.Title>Manual attention may be required</Alert.Title>
          <Alert.Description>
            <ul class="flex list-disc flex-col gap-1 pl-4">
              {#each result.warnings as warning (warning)}
                <li>{warning}</li>
              {/each}
            </ul>
          </Alert.Description>
        </Alert.Root>
      {/if}
      <AlertDialog.Footer>
        <AlertDialog.Action onclick={() => finish(result)}
          >Done</AlertDialog.Action
        >
      </AlertDialog.Footer>
    {:else}
      <AlertDialog.Header>
        <AlertDialog.Media>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </AlertDialog.Media>
        <AlertDialog.Title>
          {reviewingForce
            ? "Confirm forced removal"
            : "Remove managed worktree"}
        </AlertDialog.Title>
        <AlertDialog.Description>
          {reviewingForce
            ? "This override may discard changed files or break a Git worktree lock."
            : "Removes the worktree directory. The managed branch is kept for separate cleanup."}
        </AlertDialog.Description>
      </AlertDialog.Header>

      <div class="flex min-w-0 flex-col gap-2">
        <p class="font-medium">{worktree.name}</p>

        {#if loading}
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Inspecting removal safety…
          </div>
        {:else if inspection}
          {#if inspection.issues.length > 0}
            <Alert.Root variant="destructive">
              <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
              <Alert.Title>Removal safety checks found issues</Alert.Title>
              <Alert.Description>
                <ul class="flex list-disc flex-col gap-1 pl-4">
                  {#each inspection.issues as issue (issue.code)}
                    <li>{issue.summary}</li>
                  {/each}
                </ul>
              </Alert.Description>
            </Alert.Root>
          {:else if !reviewingForce}
            {@const status = statusParts(inspection)}
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt class="text-muted-foreground">Status</dt>
              <dd>{status.status}</dd>
              <dt class="text-muted-foreground">Removal</dt>
              <dd>{status.removal}</dd>
              <dt class="text-muted-foreground">Branch</dt>
              <dd>{status.branch}</dd>
            </dl>
          {/if}
        {/if}
      </div>

      {#if !loading && inspection}
        {#if reviewingForce}
          {#if inspection.warnings.length > 0}
            <Alert.Root variant="destructive">
              <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
              <Alert.Title
                >Branches or metadata will be left untouched</Alert.Title
              >
              <Alert.Description>
                <ul class="flex list-disc flex-col gap-1 pl-4">
                  {#each inspection.warnings as warning (warning)}
                    <li>{warning}</li>
                  {/each}
                </ul>
              </Alert.Description>
            </Alert.Root>
          {/if}
          <Alert.Root variant="destructive">
            <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
            <Alert.Title>This action cannot be undone</Alert.Title>
            <Alert.Description>
              The worktree directory will be removed recursively. Mounted
              content is never crossed. Dirty files and any Git lock are
              intentionally overridden.
            </Alert.Description>
          </Alert.Root>
          <Field.FieldGroup>
            <Field.Field
              data-invalid={confirmation.length > 0 &&
                confirmation !== "delete"}
            >
              <Field.FieldLabel for="force-worktree-confirmation">
                Type <code>delete</code> to confirm
              </Field.FieldLabel>
              <Input
                id="force-worktree-confirmation"
                bind:value={confirmation}
                autocomplete="off"
                spellcheck="false"
                aria-invalid={confirmation.length > 0 &&
                  confirmation !== "delete"}
                disabled={removing}
              />
              <Field.FieldDescription>
                This confirmation authorizes dirty-file deletion and breaking
                the displayed Git lock.
              </Field.FieldDescription>
            </Field.Field>
          </Field.FieldGroup>
        {:else}
          <Collapsible.Root bind:open={detailsOpen}>
            <Collapsible.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  type="button"
                  variant="link"
                  size="sm"
                  class="h-auto px-0"
                  disabled={removing}
                >
                  {detailsOpen ? "Hide details" : "Show details"}
                </Button>
              {/snippet}
            </Collapsible.Trigger>
            <Collapsible.Content>
              <dl class="mt-3 grid gap-3 text-sm">
                <div>
                  <dt class="text-muted-foreground">Path</dt>
                  <dd class="break-all font-mono text-xs">{worktree.path}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">Expected branch</dt>
                  <dd class="break-all">
                    <code>{inspection.expected.branchRef}</code>
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">Current branch</dt>
                  <dd class="break-all">
                    <code
                      >{inspection.observed.branchRef ??
                        (inspection.observed.detached
                          ? "detached HEAD"
                          : "unavailable")}</code
                    >
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">Git repository identity</dt>
                  <dd>
                    {inspection.observed.gitCommonDir ===
                    inspection.expected.gitCommonDir
                      ? "Matches the recorded workspace"
                      : `Expected ${inspection.expected.gitCommonDir}; found ${inspection.observed.gitCommonDir ?? "none"}`}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">Changes</dt>
                  <dd>
                    {inspection.dirty.available
                      ? `${inspection.dirty.tracked} tracked, ${inspection.dirty.untracked} untracked`
                      : "Could not be inspected"}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">Removal strategy</dt>
                  <dd>
                    {inspection.removalStrategy === "git"
                      ? inspection.observed.locked
                        ? "Git removal with lock override"
                        : "Git-managed removal"
                      : "Filesystem-only removal; Git metadata is left untouched"}
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">Branch handling</dt>
                  <dd>
                    {inspection.branchDisposition.kind === "adopt_observed"
                      ? `Adopt ${inspection.branchDisposition.cleanupBranchRef} for separate cleanup`
                      : inspection.branchDisposition.kind === "recorded"
                        ? `Keep ${inspection.branchDisposition.cleanupBranchRef} for separate cleanup`
                        : "Leave all branches for manual management"}
                  </dd>
                </div>
              </dl>
            </Collapsible.Content>
          </Collapsible.Root>
        {/if}
      {/if}

      {#if error}
        <Alert.Root variant="destructive" role="alert">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}

      <AlertDialog.Footer>
        {#if reviewingForce}
          <Button
            variant="outline"
            disabled={removing}
            onclick={() => {
              reviewingForce = false;
              confirmation = "";
            }}
          >
            <HugeiconsIcon
              icon={ArrowLeft01Icon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            Back
          </Button>
        {:else}
          <AlertDialog.Cancel disabled={removing} onclick={close}
            >Cancel</AlertDialog.Cancel
          >
        {/if}

        {#if inspection && !loading}
          {#if reviewingForce}
            <AlertDialog.Action
              variant="destructive"
              disabled={removing || confirmation !== "delete"}
              onclick={(event) => {
                event.preventDefault();
                void remove("force");
              }}
            >
              {#if removing}
                <Spinner data-icon="inline-start" />
              {:else}
                <HugeiconsIcon
                  icon={Delete02Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
              {/if}
              {removing ? "Force removing…" : "Force remove worktree"}
            </AlertDialog.Action>
          {:else if inspection.safeRemovalAllowed}
            <AlertDialog.Action
              variant="destructive"
              disabled={removing}
              onclick={(event) => {
                event.preventDefault();
                void remove("safe");
              }}
            >
              {#if removing}
                <Spinner data-icon="inline-start" />
              {:else}
                <HugeiconsIcon
                  icon={Delete02Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
              {/if}
              {removing ? "Removing…" : "Remove clean worktree"}
            </AlertDialog.Action>
          {:else if inspection.forceRemovalAllowed}
            <AlertDialog.Action
              variant="destructive"
              onclick={(event) => {
                event.preventDefault();
                reviewingForce = true;
              }}>Review forced removal</AlertDialog.Action
            >
          {:else}
            <Button variant="outline" onclick={() => void prepare()}
              >Inspect again</Button
            >
          {/if}
        {/if}
      </AlertDialog.Footer>
    {/if}
  </AlertDialog.Content>
</AlertDialog.Root>
