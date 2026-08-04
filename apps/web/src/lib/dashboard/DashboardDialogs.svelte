<script lang="ts">
  import type {
    RemoveWorktreeResponse,
    WorkspaceDto,
    WorktreeDto,
  } from "@pi-dash/contracts";
  import AddWorkspaceDialog from "../workspaces/AddWorkspaceDialog.svelte";
  import RemoveWorkspaceDialog from "../workspaces/RemoveWorkspaceDialog.svelte";
  import RenameWorkspaceDialog from "../workspaces/RenameWorkspaceDialog.svelte";
  import CreateWorktreeDialog from "../worktrees/CreateWorktreeDialog.svelte";
  import DeleteBranchDialog from "../worktrees/DeleteBranchDialog.svelte";
  import RemoveWorktreeDialog from "../worktrees/RemoveWorktreeDialog.svelte";

  export let showAdd: boolean;
  export let nativeDialogAvailable: boolean;
  export let renameTarget: WorkspaceDto | undefined;
  export let removeTarget: WorkspaceDto | undefined;
  export let createWorktreeWorkspace: WorkspaceDto | undefined;
  export let createWorktreeSyncing: boolean;
  export let removeWorktreeTarget: WorktreeDto | undefined;
  export let deleteBranchTarget: WorktreeDto | undefined;
  export let selectedWorkspace: WorkspaceDto | undefined;
  export let mainContent: HTMLDivElement | null;
  export let onCloseAdd: () => void;
  export let onCreatedWorkspace: (workspace: WorkspaceDto) => void;
  export let onExistingWorkspace: (id: string) => void;
  export let onCloseRename: () => void;
  export let onRenamedWorkspace: (workspace: WorkspaceDto) => void;
  export let onCloseRemove: () => void;
  export let onRemovedWorkspace: (id: string) => void;
  export let onCloseCreateWorktree: () => void;
  export let onSyncCreateWorktree: () => void;
  export let onCreatedWorktree: (worktree: WorktreeDto) => void;
  export let onCloseRemoveWorktree: () => void;
  export let onRemovedWorktree: (result: RemoveWorktreeResponse) => void;
  export let onCloseDeleteBranch: () => void;
  export let onDeletedBranch: (workspaceId: string, worktreeId: string) => void;
</script>

{#if showAdd}
  <AddWorkspaceDialog
    nativeAvailable={nativeDialogAvailable}
    onClose={onCloseAdd}
    onCreated={onCreatedWorkspace}
    onExisting={onExistingWorkspace}
  />
{/if}
{#if renameTarget}
  <RenameWorkspaceDialog
    workspace={renameTarget}
    onClose={onCloseRename}
    onRenamed={onRenamedWorkspace}
  />
{/if}
{#if removeTarget}
  <RemoveWorkspaceDialog
    workspace={removeTarget}
    fallbackFocus={mainContent}
    onClose={onCloseRemove}
    onRemoved={onRemovedWorkspace}
  />
{/if}
{#if createWorktreeWorkspace}
  {@const createTarget = createWorktreeWorkspace}
  <CreateWorktreeDialog
    workspace={createTarget}
    syncing={createWorktreeSyncing}
    onSync={onSyncCreateWorktree}
    onClose={onCloseCreateWorktree}
    onCreated={onCreatedWorktree}
  />
{/if}
{#if removeWorktreeTarget}
  <RemoveWorktreeDialog
    worktree={removeWorktreeTarget}
    fallbackFocus={mainContent}
    onClose={onCloseRemoveWorktree}
    onRemoved={onRemovedWorktree}
  />
{/if}
{#if deleteBranchTarget && selectedWorkspace}
  <DeleteBranchDialog
    workspace={selectedWorkspace}
    worktree={deleteBranchTarget}
    fallbackFocus={mainContent}
    onClose={onCloseDeleteBranch}
    onDeleted={onDeletedBranch}
  />
{/if}
