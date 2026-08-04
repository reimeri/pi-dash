# Managed worktree lifecycle

Pi Dash creates linked Git worktrees only beneath `<data>/worktrees/<workspace-id>/<worktree-id>-<slug>`. The UUID makes allocation stable and collision-resistant; the suffix remains readable. The daemon verifies canonical containment before and after Git creation and never adopts an unrecorded worktree during reconciliation.

## Creation

1. `GET /api/v1/workspaces/:id/refs` resolves `HEAD`, local branches, and tags to exact commit OIDs. Every result carries a five-minute HMAC snapshot binding the workspace, full ref, OID, and expiry.
2. The create request repeats the full ref, OID, and token and supplies an `Idempotency-Key` UUID.
3. SQLite durably records the operation and a `creating` worktree before Git mutation.
4. A daemon-local mutex and non-blocking `flock` keyed by the canonical Git common directory serialize related repositories, including daemons using different data roots.
5. Git receives an argument array equivalent to `git worktree add -b <branch> <path> <exact-oid>`.
6. Pi Dash verifies canonical path containment, branch, HEAD, and common-directory identity before transitioning to `ready`.

A failed create compensates only when the exact allocated path, expected branch, and expected base OID prove ownership. Ambiguous state transitions to `error`; creation recovery never recursively deletes an uncertain path.

## Removal inspection and confirmation

`POST /api/v1/worktrees/:id/remove/prepare` produces a structured inspection of:

- the recorded and deterministic allocated paths;
- path type and canonical location;
- recorded and observed branch, HEAD, and Git common directory;
- tracked and untracked change counts;
- detached, locked, prunable, and mount states;
- the selected Git-managed or filesystem-only removal strategy;
- branch disposition and any refs that will be left untouched.

The response includes a short-lived HMAC confirmation token bound to the worktree record version and complete inspection snapshot. Removal re-inspects under the mutation lock and refuses stale or changed confirmations.

An exact, clean, unlocked worktree uses safe removal. Any mismatch, dirt, or lock requires a second destructive review and the exact typed confirmation `delete`. Mounted or bind-mounted content at or below the allocation is always a hard blocker.

## Removal execution

The shared lifecycle coordinator claims `ready → removing` before stopping runtimes. Pi and shell startup leases remain held through path verification and PTY spawn, and removal cannot claim the worktree while either kind is starting. After removal is claimed, no new runtime may start. Both the Pi process group and the shell PTY session are disposed before filesystem mutation. Recoverable `error` records may also enter `removing` through the explicitly confirmed force path. Once filesystem mutation starts, client cancellation no longer aborts cleanup; the durable operation journal is finalized immediately or by reconciliation.

For a worktree still proven to belong to the recorded Git common directory, Pi Dash delegates deletion and metadata cleanup to Git:

- normal `git worktree remove` for safe removal;
- `git worktree remove --force` for dirty forced removal;
- `git worktree remove --force --force` when the confirmation also overrides a Git worktree lock.

A changed observed branch is adopted for later cleanup only when it is a resolvable `refs/heads/pi-dash/*` ref and no other managed record in the common directory owns it. The previous recorded branch is left untouched and reported to the user. Detached, non-Pi-Dash, conflicting, or otherwise unprovable branches remain manual.

If Git identity cannot be proven, Pi Dash never mutates unknown Git metadata. It recomputes the deterministic allocation from trusted record fields, requires exact path equality, rejects mounted content, atomically moves the directory entry into an operation-specific quarantine beneath the managed workspace directory, verifies its filesystem identity, and recursively removes only that quarantine entry without following symlinks. The managed row is then forgotten and all Git refs and external metadata are left for manual management.

## Removal outcomes

A removal has one of two durable outcomes:

- **`removed_with_branch_cleanup`** retains a temporary tombstone for the recorded or safely adopted Pi Dash branch.
- **`forgotten`** removes the managed row because no branch can safely be claimed; the response contains manual-cleanup warnings.

The removal journal records strategy, phase, original/quarantine paths, filesystem identity, original and cleanup refs, inspection, and warnings. Completed operation receipts remain replayable even when a forgotten row no longer exists.

## Branch deletion

A separate confirmation submits the tombstone's final tip and a fresh exact workspace `HEAD` safety target. Under the common-directory lock, Pi Dash verifies:

- no worktree uses the branch;
- the ref still equals the recorded tip;
- that tip is an ancestor of the explicit safety target.

It then runs `git update-ref -d <ref> <expected-tip>`. A moved or unmerged branch is left intact and does not undo worktree removal. Once absence is verified, one SQLite transaction completes the operation receipt and deletes the tombstone, releasing its slug and managed branch identity for reuse.

## Reconciliation

Startup and manual reconciliation run under the same common-directory mutation lock. Exact interrupted creates may become `ready`; intact pre-mutation removals return to their prior recoverable state. A Git removal whose path and worktree entry are both absent is finalized from its durable cleanup ref/tip. A filesystem-only removal resumes purge from the journaled quarantine path and finalizes as forgotten once both original and quarantine paths are absent.

Reconciliation never deletes a new replacement at the original path, crosses mounted content, adopts an unknown worktree, or changes unknown Git metadata. Ambiguous state remains visible as `error`, `missing`, or `git_mismatch` with the journal retained for another recovery attempt.
