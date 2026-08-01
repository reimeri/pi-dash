# Managed worktree recovery

Pi Dash reconciles managed worktrees at startup and from the workspace **Reconcile** action. Reconciliation is conservative: it updates recorded rows only and never adopts, removes, or repairs an unknown Git worktree.

## Inspect Git state

Use the registered repository as the working directory:

```sh
git worktree list --porcelain
git status --porcelain=v1 --untracked-files=all
git show-ref --verify refs/heads/pi-dash/<worktree-slug>
git rev-parse --path-format=absolute --git-common-dir
```

The dashboard record shows the expected managed path, branch ref, base commit, lifecycle, and sanitized error. Compare all of them before changing Git metadata manually.

## Lifecycle recovery

- **`creating` / create error:** Reconcile promotes only an exact path/branch/base/common-dir match. If the path is unknown or the branch moved, Pi Dash leaves `error`. Inspect it manually; do not assume the directory is disposable.
- **`removing`:** If both the Git entry and allocated path are absent, reconciliation completes the tombstone. If the exact worktree remains, it returns to `ready` with a warning. Partial or mismatched state remains `error`.
- **`missing` or `git_mismatch`:** Restore the recorded path and Git metadata externally, then reconcile. Pi Dash does not move or adopt worktrees.
- **`locked`:** Inspect `git worktree list --porcelain` and unlock externally only if the repository owner intends it. Pi Dash does not override Git worktree locks.
- **`WORKTREE_DIRTY`:** Commit, stash, or clean tracked and untracked changes outside the removal operation. Reconcile, then retry removal with a new client operation ID.

## Branch recovery

Removal and branch deletion are independent. A `BRANCH_NOT_MERGED` or `BRANCH_CHANGED` refusal leaves the removed worktree tombstone and the branch intact. Merge the branch into the intended workspace target or manage it manually. Pi Dash never force-deletes a branch.

The atomic deletion guarantee applies only when the branch ref still equals the tombstone's expected OID. `git update-ref -d <ref> <expected-oid>` fails rather than deleting a moved ref.

## Downgrade warning

Restoring a pre-Phase-3 database cannot undo linked worktrees or branches already created in Git. Before restoring an older database backup, use the newer daemon to reconcile and cleanly remove managed worktrees, then verify `git worktree list --porcelain` manually.
