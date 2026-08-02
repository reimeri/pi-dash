# Managed worktree lifecycle

Pi Dash creates linked Git worktrees only beneath `<data>/worktrees/<workspace-id>/<worktree-id>-<slug>`. The UUID makes allocation stable and collision-resistant; the suffix remains readable. The daemon verifies canonical containment before and after Git creation and never adopts an unrecorded worktree.

## Creation

1. `GET /api/v1/workspaces/:id/refs` resolves `HEAD`, local branches, and tags to exact commit OIDs. Every result carries a five-minute HMAC snapshot binding the workspace, full ref, OID, and expiry.
2. The create request repeats the full ref, OID, and token and supplies an `Idempotency-Key` UUID.
3. SQLite durably records the operation and a `creating` worktree before Git mutation.
4. A daemon-local mutex and non-blocking `flock` keyed by the canonical Git common directory serialize related repositories, including daemons using different data roots.
5. Git receives an argument array equivalent to `git worktree add -b <branch> <path> <exact-oid>`.
6. Pi Dash verifies canonical path containment, branch, HEAD, and common-directory identity before transitioning to `ready`.

A failed create compensates only when the exact allocated path, expected branch, and expected base OID prove ownership. Ambiguous state transitions to `error`; Pi Dash does not recursively delete an uncertain path.

## Removal

Removal is clean-only. `git status --porcelain=v1 -z --untracked-files=all` runs before lifecycle claim and again immediately before mutation. Any tracked or untracked entry returns `WORKTREE_DIRTY`; there is no force path.

The shared lifecycle coordinator atomically claims `ready → removing` before invoking the future terminal-stop hook. Phase 4 must use the same coordinator and start processes only while lifecycle is `ready`. An exact intact command failure restores `ready` with a warning. Ambiguous partial state becomes `error`; verified absence becomes `removed`.

Removed rows are durable tombstones only while their managed branch remains. They do not count as active dependents when removing a workspace. Successful branch deletion atomically records an idempotent operation receipt and deletes the tombstone; the historical operation retains the former worktree ID without owning the worktree row.

## Branch deletion

Worktree removal keeps the branch. A separate confirmation submits the recorded final tip and a fresh exact workspace `HEAD` safety target. Under the common-directory lock, Pi Dash verifies:

- no worktree uses the branch;
- the ref still equals the recorded tip;
- that tip is an ancestor of the explicit safety target.

It then runs `git update-ref -d <ref> <expected-tip>`. A moved or unmerged branch is left intact and does not undo worktree removal. Once absence is verified, one SQLite transaction completes the operation receipt and deletes the tombstone, releasing its slug and managed branch identity for reuse.

## Reconciliation

Startup and manual reconciliation run under the same common-directory mutation lock and compare database records with `git worktree list --porcelain -z`. Exact interrupted creates may become `ready`; verified completed removals become `removed` only when the final branch tip was durable before removal; exact intact removals return to `ready`. Mismatches remain visible as `error`, `missing`, or `git_mismatch`. Unknown Git worktrees are never adopted or removed.

Durable `in_progress` idempotency rows are reconciled with lifecycle postconditions. Proven create/remove outcomes receive their original durable response, while ambiguous operations become a durable failure rather than remaining in progress forever. For branch deletion, durable delete intent plus the expected absent-branch postcondition completes the receipt and removes the tombstone after a crash; an unchanged or moved ref remains a durable failure. Completed receipts remain replayable after worktree deletion but are removed if the workspace metadata is deleted.
