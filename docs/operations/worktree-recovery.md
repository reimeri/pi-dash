# Managed worktree recovery

Pi Dash reconciles managed worktrees at startup and from the workspace **Reconcile** action. Reconciliation updates recorded rows and resumes journaled Pi Dash removal operations; it never adopts an unknown worktree or modifies Git metadata whose repository identity cannot be proven.

## Inspect Git state

Use the registered repository as the working directory:

```sh
git worktree list --porcelain
git status --porcelain=v1 --untracked-files=all
git show-ref --verify refs/heads/pi-dash/<worktree-slug>
git rev-parse --path-format=absolute --git-common-dir
```

The removal dialog now displays the recorded and observed path, branch, common directory, HEAD availability, dirty counts, lock state, removal strategy, and branch disposition. Compare these values before confirming destructive recovery.

## Normal and forced removal

An exact, clean, unlocked worktree can be removed directly. If the branch changed, HEAD became detached, files are dirty, the worktree is locked, or Git identity is damaged, Pi Dash shows a second review rather than the former generic “exact managed path and Git identity” error.

Forced removal requires typing lowercase `delete`. It may:

- discard tracked and untracked changes;
- override a Git worktree lock, including its displayed lock reason;
- adopt the currently observed branch only when it is an unclaimed `refs/heads/pi-dash/*` branch;
- recursively remove an unprovable deterministic Pi Dash allocation while leaving unknown Git metadata untouched.

Mounted or bind-mounted content at or below the allocation blocks removal even after confirmation. Unmount it and inspect the path again.

When a changed Pi Dash branch is adopted, the previously recorded branch is explicitly left untouched. Detached, non-Pi-Dash, conflicting, and unprovable branches are never offered for automatic cleanup.

## Filesystem-only removal

Filesystem-only removal is used when the exact deterministic allocation can be proven but its Git identity cannot. Pi Dash quarantines and removes only that allocation, forgets the managed row, and reports that branches or stale worktree metadata may require manual cleanup.

After this outcome, inspect the repository with:

```sh
git worktree list --porcelain
git worktree prune --dry-run
git branch --list 'pi-dash/*'
```

Do not run `git worktree prune` without reviewing its complete dry-run output; pruning can affect other stale worktree registrations. Pi Dash intentionally does not run broad pruning automatically.

## Interrupted removal

The durable removal journal tracks preparation, mutation start, quarantine, purge, and finalization.

- **Original path still intact:** Reconciliation restores a retryable state or leaves a precise error.
- **Git-managed path and entry absent:** Reconciliation completes the branch tombstone or forgotten outcome from the durable branch disposition.
- **Quarantine exists:** Reconciliation checks mount boundaries again, resumes purge only at the journaled quarantine path, and never touches a replacement at the original allocation.
- **Purge remains blocked:** The row stays in error with its journal retained. Inspect permissions, active mounts, and the `.pi-dash-trash` directory under that workspace's managed allocation parent.

A client disconnect after mutation starts does not cancel cleanup. A retry with the same idempotency key returns the durable result once reconciliation finishes.

## Lifecycle recovery

- **`creating` / create error:** Reconcile promotes only an exact path/branch/base/common-dir match. If the path is unknown or the branch moved, Pi Dash leaves `error`.
- **`removing`:** Reconciliation uses the removal journal and definitive Git/filesystem postconditions. Do not manually recreate content at the original path while recovery is in progress.
- **`missing` or `git_mismatch`:** Open removal to see the expected/current mismatch. Restore the recorded identity externally for safe removal, or review the destructive filesystem-only path.
- **`locked`:** The force review shows the Git lock reason and requires typed confirmation before using Git's double-force removal.
- **`WORKTREE_DIRTY`:** Safe removal remains unavailable. Commit, stash, or clean externally, or explicitly review and confirm destructive removal.
- **`MOUNT_PRESENT`:** Unmount all listed paths; this blocker cannot be overridden.

## Branch recovery

Removal and branch deletion remain independent. A `BRANCH_NOT_MERGED` or `BRANCH_CHANGED` refusal leaves the tombstone branch intact. Merge it into the intended workspace target or manage it manually. Pi Dash never force-deletes a branch ref.

The atomic deletion guarantee applies only when the branch ref still equals the tombstone's expected OID. `git update-ref -d <ref> <expected-oid>` fails rather than deleting a moved ref. After successful deletion, Pi Dash stores an idempotent receipt and removes the tombstone so its slug can be reused.

## Downgrade warning

Restoring a database from before schema version 6 discards removal journals and cannot undo worktree directories or branches already changed by Git. Finish or reconcile all removal operations with the newer application, inspect `git worktree list --porcelain`, and only then restore an older backup.
