<script lang="ts">
  import type {
    GitRefDto,
    WorkspaceDto,
    WorktreeDto,
  } from "@pi-dash/contracts";
  import { AlertCircleIcon, Delete02Icon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onMount } from "svelte";
  import * as Alert from "$lib/components/ui/alert";
  import * as AlertDialog from "$lib/components/ui/alert-dialog";
  import { Button } from "$lib/components/ui/button";
  import * as Collapsible from "$lib/components/ui/collapsible";
  import { Spinner } from "$lib/components/ui/spinner";
  import { ApiClientError, api } from "../../api.js";

  export let workspace: WorkspaceDto;
  export let worktree: WorktreeDto;
  export let fallbackFocus: HTMLElement | null = null;
  export let onClose: () => void;
  export let onDeleted: (workspaceId: string, worktreeId: string) => void;
  let safetyTarget: (GitRefDto & { ref: string }) | null = null;
  let loading = true;
  let deleting = false;
  let detailsOpen = false;
  let error = "";
  let operationId = crypto.randomUUID();
  let dialogOpen = true;
  let returnFocus: HTMLElement | null = null;

  function restoreFocus(): void {
    requestAnimationFrame(() => {
      const target = returnFocus?.isConnected ? returnFocus : fallbackFocus;
      if (target?.isConnected) target.focus();
    });
  }

  function close() {
    if (deleting) return;
    onClose();
    restoreFocus();
  }

  function finishClose(): void {
    onClose();
    restoreFocus();
  }
  async function loadTarget() {
    try {
      const response = await api.worktreeRefs(workspace.id);
      safetyTarget = response.head;
      if (!safetyTarget) error = "Workspace HEAD does not resolve to a commit.";
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "Unable to resolve workspace HEAD.";
    } finally {
      loading = false;
    }
  }
  async function removeBranch() {
    if (!safetyTarget || !worktree.finalBranchTip) return;
    deleting = true;
    error = "";
    try {
      const response = await api.deleteWorktreeBranch(
        worktree.id,
        {
          expectedBranchTip: worktree.finalBranchTip,
          safetyTargetCommit: safetyTarget.commit,
        },
        operationId,
      );
      onDeleted(response.workspaceId, response.worktreeId);
      finishClose();
    } catch (caught) {
      error =
        caught instanceof ApiClientError &&
        caught.envelope?.error.code === "BRANCH_NOT_MERGED"
          ? "The branch is not merged into the displayed workspace HEAD. It was not deleted; the worktree remains removed."
          : caught instanceof Error
            ? caught.message
            : "Unable to delete branch.";
      if (caught instanceof ApiClientError) operationId = crypto.randomUUID();
      deleting = false;
    }
  }
  onMount(() => {
    returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    void loadTarget();
  });
</script>

<AlertDialog.Root bind:open={dialogOpen}>
  <AlertDialog.Content
    onEscapeKeydown={(event) => {
      event.preventDefault();
      if (!deleting) close();
    }}
    onInteractOutside={(event) => {
      event.preventDefault();
      if (!deleting) close();
    }}
  >
    <p class="sr-only" role="status" aria-live="polite">
      {deleting ? "Verifying and deleting managed branch" : ""}
    </p>
    <AlertDialog.Header>
      <AlertDialog.Media>
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
      </AlertDialog.Media>
      <AlertDialog.Title>Delete removed worktree branch</AlertDialog.Title>
      <AlertDialog.Description>
        Deletes the recorded branch only if it is merged into workspace HEAD.
      </AlertDialog.Description>
    </AlertDialog.Header>

    <div class="min-w-0">
      <p class="font-medium">{worktree.name}</p>
      <p class="mt-0.5 break-all font-mono text-sm text-muted-foreground">
        {worktree.branchRef}
      </p>
    </div>

    {#if loading}
      <div
        class="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner aria-hidden="true" />Resolving workspace HEAD…
      </div>
    {:else if safetyTarget}
      <Collapsible.Root bind:open={detailsOpen}>
        <Collapsible.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              type="button"
              variant="link"
              size="sm"
              class="h-auto px-0"
              disabled={deleting}
            >
              {detailsOpen ? "Hide details" : "Details"}
            </Button>
          {/snippet}
        </Collapsible.Trigger>
        <Collapsible.Content>
          <dl class="mt-3 grid gap-3 text-sm">
            <div>
              <dt class="text-muted-foreground">Expected branch tip</dt>
              <dd><code class="break-all">{worktree.finalBranchTip}</code></dd>
            </div>
            <div>
              <dt class="text-muted-foreground">Safety target</dt>
              <dd>
                <code class="break-all"
                  >{safetyTarget.fullName} at {safetyTarget.commit}</code
                >
              </dd>
            </div>
          </dl>
        </Collapsible.Content>
      </Collapsible.Root>
    {/if}

    {#if error}
      <Alert.Root variant="destructive" role="alert">
        <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={2} />
        <Alert.Description>{error}</Alert.Description>
      </Alert.Root>
    {/if}

    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deleting} onclick={close}
        >Keep branch</AlertDialog.Cancel
      >
      <AlertDialog.Action
        variant="destructive"
        disabled={deleting || !safetyTarget}
        onclick={(event) => {
          event.preventDefault();
          void removeBranch();
        }}
      >
        {#if deleting}<Spinner data-icon="inline-start" />{:else}<HugeiconsIcon
            icon={Delete02Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />{/if}
        {deleting ? "Verifying and deleting…" : "Delete merged branch"}
      </AlertDialog.Action>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
