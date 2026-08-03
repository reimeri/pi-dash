# Pi Dash Simplification Plan

This plan reduces over-engineering in Pi Dash while preserving the product: a **local** Linux dashboard for **git worktree management** and a clean UI for **running the Pi agent**.

`AGENTS.md` applies: **do not preserve backwards compatibility**. Prefer deleting obsolete paths over compatibility layers. API clients and SQLite schemas may break across phases — but **managed worktree directories must never be destroyed** by a reset instruction.

Accessibility redesign and public multi-user hosting are out of scope. Do **not** proactively strip existing accessibility behavior; simply do not expand or redesign it.

---

## 1. Goals

1. Cut distributed-systems / SaaS patterns that do not serve a single-user local tool (HMAC confirmations, HTTP idempotency ledgers, cursor-based UI events, Drizzle, excess contracts).
2. Keep inexpensive local safety controls (Host/Origin, removal preflights, sync execution sandbox, lifecycle states, gitCommonDir locking).
3. Keep the core UX working: add workspaces, create/remove managed worktrees, optional branch cleanup after remove, open a Pi PTY terminal, see a simple workflow status badge.
4. Leave the codebase understandable enough that a new contributor can follow create/remove/terminal/status without reading multi-thousand-line durability docs.
5. Ship the work as a sequence of reviewable phases, each with an explicit exit validation gate that protects the stated invariants.

## 2. Non-goals

- Redesigning the visual language or pruning the shadcn-svelte component kit (keep registry-shaped source so `shadcn-svelte update` stays workable). Splitting oversized app shells is in scope.
- Replacing xterm / node-pty / the Pi extension integration with something else.
- Supporting remote/multi-user hosting.
- Preserving existing SQLite schemas, HMAC tokens, idempotency keys, or protocol version numbers.
- Perfect error-code stability for external API consumers (there are none) — but **UI-driving error discriminants stay stable**.
- A full accessibility redesign (existing a11y behavior may remain).
- Supporting two Pi Dash data roots that manage the same git repository concurrently.

## 3. Invariants (must still work after every phase)

| Capability | Critical path |
|---|---|
| Workspace add / list / remove / rename / reorder | `workspace-routes.ts` → `WorkspaceService` → SQLite + `git-inspector` + native directory dialog → `WorkspaceSidebar` |
| Managed worktree create / remove | routes → `WorktreeService` → `git-worktree-manager.ts` → SQLite → create/remove dialogs |
| Branch cleanup after remove | Minimal tombstone row + `DeleteBranchDialog` + mergedness check |
| Pi PTY terminal | `terminal-manager.ts` → `terminal-runtime.ts` → WS routes → `TerminalPane.svelte` |
| Status badge (simpler OK) | Pi extension → status.sock → StatusService → snapshot WS → UI indicator |
| Loopback-only daemon | bind `127.0.0.1` / `::1` only |
| Desktop interactive use | Electron host can spawn daemon and load UI |
| Browser/dev path | `npm run dev` can authenticate and use the API |

**Always keep:**

- Path containment under the managed worktree root (`worktree-validation.ts` / canonical path checks).
- Removal preflight safety checks listed in Phase 2 (mount, symlink, git list identity, PTY stopped, etc.).
- Cheap lifecycle states: `creating → ready` and `removing → removed|error` (no invisible orphans).
- A mutex keyed by **`gitCommonDir`** shared by workspace sync and worktree mutations (today: `git-mutation-lock.ts` via `daemon.ts`). Cross-process `flock` may be dropped; if so, document that two data roots on one repo are unsupported.
- Thin worktree lifecycle claims so terminal start and remove cannot race (`worktree-lifecycle.ts` + `claimTerminalStart` / `verifyTerminalStart`).
- Host validation + allowed Origin checks for mutations and WebSockets; HttpOnly + SameSite=Strict cookies.
- Fail-open status: if the status channel is down, the terminal still works.
- Runtime validation at every untrusted boundary: REST bodies, WebSocket frames, status-socket NDJSON, configuration, and persisted JSON.

## 4. Locked product decisions

These decisions are part of the plan. Do not re-litigate mid-flight unless blocked.

| Decision | Choice | Rationale |
|---|---|---|
| Delivery | Keep **Electron as primary** interactive product. Keep a **slim browser/dev daemon** path for `npm run dev` / automation. | README: browser cannot support every Pi keybinding; deleting desktop loses the product. Deleting browser hurts local web development. |
| Auth | Loopback bind + short-lived bootstrap (or desktop cookie handoff). **Drop CSRF.** **Retain** exact Host validation, allowed Origin checks for mutations/WS, HttpOnly cookies, SameSite=Strict. Keep `apps/server/src/security.ts` (it is small and not over-engineering). | Loopback bind alone does not stop DNS rebinding; the server still sees a loopback connection. CSRF is the dispensable part. |
| Worktrees | Remove idempotency ledger, HMAC snapshot/confirmation tokens, quarantine **journal**, and crash-recovery reconcile. **Retain** lifecycle states, removal preflights (including mount checks), in-process `gitCommonDir` lock, and a **minimal tombstone** for branch cleanup. | Local tool does not need durable ops journals; it does need not to delete the wrong tree or leave invisible orphans. |
| Branch cleanup | **Retain** current UX: after successful worktree remove, keep a minimal tombstone so the user can “Delete merged branch”. Require tip-OID equality **and** mergedness against an explicit safety target. | Tip-OID alone prevents deleting a moved branch but not unmerged work. E2E covers this (`tests/e2e/worktrees.spec.ts`). |
| Status | Keep Pi extension + unix status socket + badge. **Application events = snapshot WebSocket** (locked; not polling). Drop cursor gap protocol and acknowledge-by-revision API. Retain runtime ID, extension instance ID, and sequence handling to reject stale/out-of-order frames. Define dismiss-`done` with a monotonic completion generation so an old dismissal cannot clear a newer completion. | Badge value is `idle \| working \| blocked \| done`. |
| Sync | Thin the sync **state taxonomy**. **Retain** fixed non-interactive environment, disabled hooks/submodules, protocol restrictions, and protection from executable local Git configuration in `git-workspace-sync.ts`. | `git fetch`/`pull` can invoke credential helpers, SSH, proxies, hooks, and unsafe protocols from repo config. |
| Data | Prefer schema squash over migration compatibility. Drop Drizzle. **Never** instruct operators to delete the whole data directory. Use a **DB-only reset** that preserves `worktrees/` (see Phase 5). | `paths.ts` colocates `pi-dash.sqlite` and managed worktrees; wiping data dir can destroy dirty uncommitted user files. |
| Contracts | Shared **TypeScript types**; server validates untrusted inputs; client may drop fail-closed response `Value.Check` in production (optional dev asserts). Keep validation for all untrusted boundaries listed under invariants. | Server and web ship together; untrusted boundaries still need runtime checks. |
| Errors | Smaller `ApiErrorCodes` catalog. **Every UI-branching condition keeps a stable discriminant.** Messages are presentation only — never branch UI on message text. | Message text is unstable and localization/copy-hostile. |
| Multi-root | Explicitly unsupported: two Pi Dash data roots managing the same repository. | Consequence of dropping cross-process flock while keeping in-process `gitCommonDir` locks. |
| Compatibility | Break APIs freely between phases. Bump or remove protocol version constants rather than supporting old clients. | Local app; Electron/web rebuilt together. |

## 5. Current architecture (baseline)

```
Electron (apps/desktop) ──spawns──► Fastify daemon (apps/server)
                                         │
                         ┌───────────────┼────────────────┐
                         ▼               ▼                ▼
                      SQLite          PTY/Pi           status.sock
                         │               │                │
                         ▼               ▼                ▼
                      REST API      terminal WS     StatusService
                         │               │                │
                         └──────► web SPA ◄── application-events WS
                                  (apps/web)

packages/contracts  → TypeBox schemas used by server + web
packages/pi-extension → loaded by `pi --extension`
```

Key size hotspots today:

- `apps/server/src/worktrees/worktree-service.ts` ≈ 2280 LOC
- `packages/contracts` ≈ 1100 LOC schemas
- `apps/web/src/lib/components/ui/**` ≈ 132 files / ~3400 LOC
- `apps/web/src/App.svelte` ≈ 1291 LOC
- Status stack (server status + events + web status) ≈ 1300+ LOC
- Diff client scheduler ≈ 500 LOC; workspace sync ≈ 470 LOC

## 6. Cross-cutting validation standard

Targeted tests alone are **not** enough after phases that touch core paths.

### After every phase

```sh
npm run build
npm run lint
npm run check
npm test
```

Plus the phase-specific commands listed in that phase.

### After Phases 2, 3, 4, and 5 (major)

Additionally require:

1. Focused e2e for the touched area (listed per phase).
2. A **bounded** desktop/browser smoke (not interactive unbounded `npm run desktop` as a CI step):
   - Prefer an existing Playwright desktop/bootstrap spec, or a short script that launches, hits health/session, and exits with a timeout.
   - Manual desktop smoke is allowed for humans but must be written as a finite checklist, not “run desktop.”

### Fault injection (Phase 2 required)

Phase 2 must include automated fault injection at each Git/DB boundary (create and remove): failure after `git worktree add` before DB ready transition; failure after DB `removing` before git remove; failure after git remove before tombstone/finalize. Incomplete rows must be visible via startup health refresh — never silently orphaned on disk without a DB record when the daemon created the path, and never destructive crash recovery.

---

## 7. Phase overview

| Phase | Name | Primary outcome | Depends on |
|---|---|---|---|
| 0 | Delete process leftovers | Smaller repo, no runtime risk | — |
| 1 | Independent easy wins | Diff scheduler + sync taxonomy + config slimmed | 0 |
| 2 | Worktree de-hardening | No HMAC/idempotency/journal; safety + lifecycle retained | 0 |
| 3 | Status protocol thin | Snapshot WS badge without cursors/ack | 0 |
| 4 | Auth & delivery slim | Drop CSRF; keep Host/Origin/cookie flags | 0 (best after 1–3) |
| 5 | Database & DI cleanup | No Drizzle; DB-only reset; flatter wiring | 2, 3 |
| 4b / 5+ | Desktop log sink slim | Plain log sink **after** bootstrap secrets are redesigned | 4 |
| 6 | Contracts & error codes | Types-first contracts; small stable UI error catalog | 2, 3, 4, 5 |
| 7 | UI understanding | Split `App.svelte` into feature shells | 6 preferred |
| 8 | Docs & final gate | Docs match reality; full regression | all |

Phase 1 items can run in parallel with early Phase 2/3 prep. Do **not** start Phase 6 until worktree and status API surfaces have stopped changing. Do **not** slim desktop log redaction until Phase 4 has removed or contained bootstrap-token log emission.

Each phase below has: **Target**, **Scope**, **Tasks**, **Delete / stop doing**, **Keep**, **Validation**, **Exit criteria**.

---

## Phase 0 — Delete process leftovers

### Target

Remove non-runtime archaeology that inflates cognitive load.

### Scope

Delete only. No behavior changes.

### Tasks

1. Delete the entire spike tree: `spikes/terminal-bridge/**`
2. Delete phase trackers: `phases/**`
3. Delete the historical plan artifact: `PLAN.html`
4. Grep the repo for links to the deleted paths (`spikes/`, `phases/`, `PLAN.html`) and remove stale references from:
   - README, docs, scripts, CI, package scripts
   - `.prettierignore`
   - `.dockerignore`
   - `eslint.config.js`
5. Confirm `spikes/` is not part of npm workspaces (today it is not under `apps/*` / `packages/*`).

### Delete / stop doing

- Keeping feasibility spikes and phase HTML as living project structure.

### Keep

- Operational and architecture docs under `docs/` that still describe current behavior (update later phases as behavior changes).
- `STYLE.md`, `AGENTS.md`, `README.md`.

### Validation

```sh
npm run build
npm run lint
npm run check
npm test
rg -n "spikes/|phases/|PLAN\\.html" . --glob '!SIMPLIFICATION_PLAN.md' --glob '!node_modules/**' --glob '!.git/**'
```

Confirm `spikes/`, `phases/`, and `PLAN.html` are gone and the ripgrep sweep is clean (except this plan’s historical mentions if any — prefer none).

### Exit criteria

- Deleted paths absent from tree and ignore/lint configs.
- Unit tests / lint / typecheck / build green.

---

## Phase 1 — Independent easy wins

### Target

Reduce adjacent complexity without touching worktree durability journals or status cursors.

Work as separate PRs if desired: **1a Diff**, **1b Sync**, **1c Config**.  
(**Desktop log sink** moved to after Phase 4 — see Phase 4b.)

### 1a — Diff client scheduler

**Files**

- Rewrite/simplify: `apps/web/src/lib/diff/store.ts`
- Callers: `DiffWorkspace.svelte`, `PierreDiffView.svelte`, sidebar summary usage in `App.svelte` / workspace UI
- Tests: `apps/web/test/diff-store.test.ts`
- Server (keep limits, do not over-refactor): `apps/server/src/git/git-diff-inspector.ts`

**Target design**

- On worktree selection: one `AbortController`, fetch summary and/or full diff.
- Sidebar summaries: fetch for visible worktree IDs without a global concurrency queue / generation scheduler.
- Keep server-side size/timeout limits.

**Validation**

```sh
npm run build && npm run lint && npm run check && npm test
npm test -- apps/web/test/diff-store.test.ts apps/server/test/git-diff-inspector.test.ts apps/server/test/worktree-diff-routes.test.ts
```

Manual: open a worktree, open diff pane, switch worktrees quickly — no stale diff, no UI hang.

### 1b — Workspace sync thinning

**Files**

- Simplify taxonomy / messaging: `apps/server/src/git/git-workspace-sync.ts`
- Callers: `apps/server/src/workspaces/workspace-service.ts` (`sync`), `WorkspaceSyncIndicator.svelte`, `App.svelte`
- Error codes: keep stable discriminants for UI-visible sync failures; prune purely internal duplicates later in Phase 6
- Tests: `git-workspace-sync.test.ts`, `workspace-service.test.ts`, `workspace-api.test.ts`

**Target design**

- Sync remains `git fetch` + `git pull --ff-only` (or equivalent) with clear failure codes.
- **Simplify** the ahead/diverged/dirty/detached **UX taxonomy** if redundant, but keep guards the UI needs.
- **Must retain** (do not delete wholesale):
  - Fixed non-interactive environment (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/bin/false`, batch-mode SSH, etc.)
  - Disabled hooks (`core.hooksPath=/dev/null` or equivalent)
  - Submodule/disable and protocol allow/deny restrictions already present
  - Protection from executable / dangerous local Git configuration (`include.path`, credential helpers, `core.sshCommand`, etc.)
- Acceptable alternative only with explicit product-owner approval: remove first-class sync and document CLI use. Default: **keep thin sync with execution controls**.

**Validation**

```sh
npm run build && npm run lint && npm run check && npm test
npm test -- apps/server/test/git-workspace-sync.test.ts apps/server/test/workspace-service.test.ts apps/server/test/workspace-api.test.ts
```

Manual: sync a clean ff-only workspace; confirm dirty/diverged/unsafe-config cases show stable error codes and readable messages.

### 1c — Config surface trim

**Files**

- `apps/server/src/config.ts`
- Docs: `docs/operations/configuration.md`
- Health settings echo in `apps/server/src/app.ts`
- Desktop reserved-arg validation in `apps/desktop/src/main.ts`
- Tests: `apps/server/test/config-paths.test.ts`

**Target design**

Keep configurable:

- `host`, `port`, `dataDir`, `piExecutable`, `logLevel`
- `uiOrigin`, `staticDir`, `bootstrapOutput`, `openBrowser` / `no-open`
- Desktop-required flags only

Hardcode terminal defaults (cols/rows, buffer bytes, frame bytes, socket buffered bytes, stop grace, cache size, etc.) unless a knob is proven necessary for debugging. Prefer a single `PI_DASH_DEBUG_TERMINAL=1` later over dozens of knobs.

Config parsing remains a validated untrusted boundary.

**Validation**

```sh
npm run build && npm run lint && npm run check && npm test
npm test -- apps/server/test/config-paths.test.ts apps/server/test/daemon.test.ts
```

Bounded smoke: daemon boots under `npm run dev` and desktop spawn args still accepted.

### Phase 1 exit criteria

- Diff/sync/config changes merged (log sink **not** required yet).
- Full build/lint/check/unit green.
- No regressions in workspace add or terminal open.
- Sync execution sandbox still covered by tests.

---

## Phase 2 — Worktree de-hardening (largest cut)

### Target

Remove durable-ops machinery while keeping local FS/Git safety and visible lifecycle:

**Create** = insert `creating` → validate → `git worktree add` → verify → transition `ready`  
**Remove** = inspect → confirm in UI → claim `removing` → stop PTY → safety preflight → `git worktree remove` → verify absence → write **tombstone** (or `error`)  

Approximate impact: `worktree-service.ts` should fall from ~2280 LOC toward a much smaller service; delete HMAC/idempotency/journal modules; **retain** mount/identity helpers (possibly relocated out of quarantine flow).

### Current flow (complexity to remove)

Create today: refs endpoint signs HMAC `baseSnapshotToken` → client sends token + `Idempotency-Key` → operation ledger → lifecycle `creating` → cross-process flock → git add → verify → `ready`.

Remove today: `POST .../remove/prepare` → HMAC `confirmationToken` → multi-phase journal → quarantine rename + purge → force modes → reconcile crash recovery finalizers.

### Target API (breaking)

Keep REST shape close enough that UI churn stays local, but simplify bodies.

**Refs**

`GET /api/v1/workspaces/:id/refs`  
→ list of `{ fullRef, commitOid, ... }` **without** snapshot tokens.

**Create**

`POST /api/v1/workspaces/:id/worktrees`  
Body: `{ name, slug, baseRef, baseCommit }`  

Server must:

1. Insert/retain a `creating` row (or equivalent) **before** Git mutation, or otherwise ensure a crash cannot leave an untracked managed path without a visible record.
2. Verify `baseRef` **still resolves to** the selected `baseCommit` (not merely that the OID exists).
3. Allocate path from trusted IDs; `git worktree add`; verify path/branch/HEAD/`gitCommonDir`.
4. Transition to `ready`.

**No** `Idempotency-Key`, **no** `baseSnapshotToken`.

**Remove prepare (read-only inspect)**

`POST /api/v1/worktrees/:id/remove/prepare` **or** `GET /api/v1/worktrees/:id/removal-plan`  
→ inspection DTO: dirty counts, branch, warnings, blockers.  
**No** HMAC confirmation token.

**Remove**

`POST /api/v1/worktrees/:id/remove`  
Body: `{ force?: boolean }` or `{ confirmation?: "delete" }` for dirty force only.  

Server under `gitCommonDir` lock:

1. Re-inspect; refuse dirty without force; refuse hard blockers.
2. Claim lifecycle `removing`; stop PTY and confirm stopped.
3. Run **removal preflight** (below).
4. `git worktree remove` / `--force` as appropriate when Git identity is proven.
5. Verify path and Git worktree metadata absence.
6. Replace the ready/removing row with a **minimal tombstone** when a `pi-dash/*` branch remains eligible for cleanup; otherwise mark forgotten/error with warnings — do **not** silently drop branch cleanup UX.
7. Publish removal/update events.

**No** operation journal, quarantine rename pipeline, idempotency ledger, or destructive crash-recovery reconcile.

**If Git identity cannot be proven:** refuse automatic filesystem deletion of uncertain content. Surface an error / unhealthy state and let the operator clean up manually. Do **not** implement quarantine-as-compensation unless a later decision reintroduces it deliberately.

**Delete branch (retained feature)**

Keep “Delete merged branch” against the tombstone:

- Tip OID still equals recorded tip.
- Tip is merged into / ancestor of the explicit safety target (keep current mergedness check).
- No worktree still uses the branch.
- Then `git update-ref -d` and delete the tombstone row.

**Health refresh (replaces crash reconcile)**

Startup/manual refresh:

- Mark missing/mismatched/`creating`/`removing` stuck rows unhealthy or errored in UI.
- **Never** delete paths as part of refresh.
- Expose incomplete rows so operators can retry remove or clean up manually.

### Required removal preflight (even without quarantine)

Before mutating or deleting anything, all of the following must hold (fail closed otherwise):

1. Path derived from trusted DB fields (deterministic allocation), not client input.
2. Path is an ordinary directory, not a symlink.
3. Canonical containment under the managed worktree root.
4. Exact match in `git worktree list` (when claiming Git-managed removal).
5. Observed `gitCommonDir` equals expected recorded common dir.
6. No mount at or below the target (keep `/proc/self/mountinfo` check; this protects against deleting mounted external content).
7. PTY/runtime confirmed stopped.
8. After Git removal: path absence and Git metadata absence verified **before** transitioning to tombstone / clearing the active row.

Mount/identity helpers currently living in `managed-path-removal.ts` may be **relocated** into a small validation module; the quarantine rename/purge journal path should be deleted.

### Lifecycle states (required)

| State | Meaning |
|---|---|
| `creating` | DB record exists; Git add in progress or incomplete |
| `ready` | Usable worktree |
| `removing` | Remove claimed; Git/FS mutation in progress or incomplete |
| `removed` (tombstone) | Directory gone; optional branch cleanup pending |
| `error` / unhealthy | Operator-visible failure; no silent orphan |

Startup health refresh must list non-`ready` / non-final tombstone states.

### Files to change

| Action | Path |
|---|---|
| Rewrite | `apps/server/src/worktrees/worktree-service.ts` |
| Simplify | `apps/server/src/worktrees/worktree-repository.ts` (drop ops/journal tables; keep tombstone fields) |
| Simplify | `apps/server/src/worktrees/worktree-routes.ts` |
| Keep / extend | `apps/server/src/worktrees/worktree-validation.ts` (containment + preflight helpers) |
| Keep thin | `apps/server/src/worktrees/worktree-lifecycle.ts` |
| Relocate then delete quarantine flow | `managed-path-removal.ts` → keep mount/symlink/identity checks; delete quarantine rename/purge |
| Delete | `removal-confirmation.ts`, `base-snapshot.ts` |
| Shrink | `git-mutation-lock.ts` → in-process mutex keyed by `gitCommonDir` (still shared with `WorkspaceService`) |
| Update wiring | `apps/server/src/daemon.ts` |
| Update contracts | `packages/contracts/src/worktrees.ts` |
| Update UI | `CreateWorktreeDialog.svelte`, `RemoveWorktreeDialog.svelte`, `DeleteBranchDialog.svelte` |
| Update client | `apps/web/src/api.ts`, `apps/web/src/lib/worktrees/store.ts` |
| Schema | stop using `worktree_operations` / `worktree_removal_journal`; keep tombstone representation |
| Docs | rewrite `docs/architecture/worktree-lifecycle.md`; delete or rewrite `docs/operations/worktree-recovery.md` as “health refresh / manual cleanup” |

### Keep

- Managed path layout: `<data>/worktrees/<workspace-id>/<worktree-id>-<slug>`
- Canonical containment before/after git create
- Removal preflight list above
- Stopping terminal runtime before remove
- UI confirmation for destructive remove; typed `delete` for dirty force
- Branch naming conventions (`pi-dash/*`) and merged branch delete UX
- Shared `gitCommonDir` lock with workspace sync

### Tasks (implementation order)

1. Implement new create/remove/branch-delete service methods with lifecycle states and preflights.
2. Update contracts for create/remove/refs/tombstone DTOs.
3. Update routes: drop idempotency header and token fields.
4. Update web API + dialogs.
5. Relocate mount checks; delete HMAC/journal/quarantine modules; shrink lock to in-process `gitCommonDir`.
6. Document unsupported multi-data-root in README/ops docs.
7. Replace `worktree-service.test.ts` / `worktree-foundation.test.ts` with:
   - happy create/remove
   - dirty remove rejected / force remove
   - preflight failures (symlink, mount, git list mismatch, containment)
   - terminal stopped on remove
   - branch delete requires mergedness + tip match
   - **required fault injection** at Git/DB boundaries
8. Update e2e `tests/e2e/worktrees.spec.ts` including “Delete merged branch”.
9. Rewrite worktree docs.

### Delete / stop doing

- Idempotency keys and operation ledger
- HMAC base snapshot + removal confirmation tokens
- Quarantine rename/purge journal and crash-recovery finalizers
- Cross-process `flock` under `/run/user` (replace with in-process `gitCommonDir` mutex + unsupported multi-root policy)
- Automatic deletion of paths when Git identity is unproven

### Validation

```sh
npm run build && npm run lint && npm run check && npm test
npm test -- apps/server/test/worktree-service.test.ts apps/server/test/worktree-foundation.test.ts apps/server/test/worktree-diff-routes.test.ts
npm test -- apps/web/test/worktree-store.test.ts
npm run test:e2e -- tests/e2e/worktrees.spec.ts
```

Plus bounded desktop/browser smoke (see §6).

**Manual checklist**

1. Add a workspace.
2. Create a worktree from a branch/OID; confirm `baseRef` drift is rejected.
3. Open Pi terminal; verify cwd.
4. Remove a clean worktree; tombstone appears when branch cleanup applies.
5. “Delete merged branch” succeeds only when merged; unmerged tip is refused.
6. Dirty remove without force fails; force with confirmation succeeds.
7. Preflight blockers (mount/symlink/mismatch) refuse deletion.
8. Kill daemon mid-create and mid-remove: on restart, incomplete rows are visible; no journal auto-purge; no invisible orphan created by Pi Dash without a row.

### Exit criteria

- HMAC/idempotency/journal/quarantine-flow modules gone.
- Preflight + lifecycle + tombstone + mergedness retained and tested.
- Fault-injection tests required and green.
- E2E worktrees including branch delete green.
- Docs describe health refresh / manual cleanup, not journal recovery.

---

## Phase 3 — Status protocol thinning

### Target

Preserve the status badge. Remove event-bus cursor infrastructure.

**Locked transport: snapshot WebSocket** (not polling).

Desired end state:

```
Pi --extension pi-extension
  → NDJSON/unix status.sock
  → StatusService reducer (idle|working|blocked|done)
     with runtimeId + extensionInstanceId + seq stale-frame rejection
  → snapshot WS push
  → WorkflowStatusIndicator
```

### Drop

- Cursor continuity / gap detection / `resyncRequired`
- Client acknowledge-by-revision API: `POST /api/v1/worktrees/:id/status/acknowledge`
- Revision CAS as a user-facing protocol (`STATUS_REVISION_CHANGED`)
- Persistence fields that exist only to support ack/cursor protocols

### Keep / require

- `packages/pi-extension` event mapping
- Unix socket auth token via terminal environment (`PI_DASH_STATUS_*`)
- Fail-open when status socket cannot start
- **Runtime ID, extension instance ID, and sequence handling** sufficient to reject stale or out-of-order extension frames from dead/replaced PTYs
- Sidebar attention for `blocked` / `done`

### Snapshot WS design (locked)

On connect: send full snapshot `{ worktrees: StatusDto[], workspaces?: ... }` (include any workspace/worktree list fields that today piggy-back on the events bus, or refetch those over REST on connect — pick one approach and document it; prefer keeping simple non-cursor push events for membership if already cheap).

On change: send a full snapshot **or** a simple `{ type, payload }` **without cursors**.

Reconnect = new snapshot. No ack. No gap detection.

### Dismiss-`done` semantics (locked)

- Each transition into `done` carries a monotonic `completionId` (or equivalent generation) stored with the status row.
- UI dismiss sends `{ completionId }` (not a global revision clock).
- Server clears `done` only if `completionId` matches the current completion.
- An old dismiss must **not** clear a newer completion.
- Dismiss does not require the old acknowledge-by-revision CAS protocol.

### Files

| Area | Paths |
|---|---|
| Server status | `status/status-service.ts`, `status-socket-server.ts`, `workflow-reducer.ts`, `status-repository.ts`, `status-routes.ts` |
| Events | `events/application-events.ts` |
| Terminal hookup | `terminal/terminal-manager.ts`, `terminal/environment.ts` |
| Extension | `packages/pi-extension/src/runtime.ts` |
| Web | `apps/web/src/lib/status/events.ts`, `store.ts`, `WorkflowStatusIndicator.svelte`, `App.svelte` |
| Contracts | `packages/contracts/src/status.ts` |
| Tests | `status.test.ts`, `status-socket-server.test.ts`, `application-events.test.ts`, `apps/web/test/status-store.test.ts` |
| Docs | `docs/architecture/status-protocol.md`, `docs/operations/status-troubleshooting.md`, `docs/integrations/ask-user-status.md` |

### Tasks

1. Define snapshot WS message types + dismiss-`done` `{ completionId }` in contracts (break v5 freely; reset protocol constant).
2. Slim `StatusService`: register runtime, apply frames with stale rejection, read statuses, dismiss done by completionId.
3. Replace application-events cursor protocol with snapshot push.
4. Update web store; remove resync/ack-revision logic from `App.svelte`.
5. Delete acknowledge-by-revision route and client helper.
6. Tests for stale seq/instance rejection and old-dismiss-does-not-clear-newer-done.
7. Manual badge + fail-open checks.

### Validation

```sh
npm run build && npm run lint && npm run check && npm test
npm test -- apps/server/test/status.test.ts apps/server/test/status-socket-server.test.ts apps/server/test/application-events.test.ts
npm test -- apps/web/test/status-store.test.ts
npm run test:e2e -- tests/e2e/terminal.spec.ts
```

Plus bounded smoke (§6).

**Manual checklist**

1. Start terminal; status moves working → idle/done.
2. Ask-user / blocked state shows blocked.
3. Dismiss done; trigger a new completion; ensure an in-flight old dismiss cannot clear it (test covers this; manual sanity OK).
4. Status socket disabled → terminal still works.
5. Reconnect UI → snapshot restores statuses without cursor recovery.

### Exit criteria

- Snapshot WS only; no cursor/ack-revision protocol.
- Stale-frame rejection and completionId dismiss semantics implemented and tested.
- Badge works; fail-open preserved.
- Status docs rewritten.

---

## Phase 4 — Auth and delivery slim

### Target

Drop CSRF theater. **Keep** Host/Origin and cookie flags that defeat DNS rebinding and trivial cross-site calls.

### Target design

1. **Bind loopback only** (keep).
2. **Bootstrap**: keep one-time token exchange that sets a session cookie, **or** desktop cookie handoff when `PI_DASH_DESKTOP=true`.
3. **Delete CSRF**: stop issuing `csrfToken`, stop requiring `X-CSRF-Token`, remove from `apps/web/src/api.ts` and `auth.ts` / `app.ts`.
4. **Retain Host/Origin** via `createOriginPolicy` in `security.ts`:
   - exact Host validation against the configured server host/port
   - allowed Origin set = server origin + optional `uiOrigin` (Vite dev)
   - require Origin on mutating API and WebSocket upgrades as today
5. **Retain cookie flags**: HttpOnly, SameSite=Strict (and existing secure/path attributes as applicable on loopback).
6. **WS auth**: session cookie + Host/Origin checks.
7. Docs: rewrite `docs/operations/local-security.md` honestly — local Unix account is the trust boundary, **plus** Host/Origin as DNS-rebinding mitigation.

### Files

- `apps/server/src/auth.ts`
- `apps/server/src/security.ts` (**keep**; do not gut)
- `apps/server/src/app.ts`
- `apps/server/src/browser.ts`
- `apps/server/src/startup.ts`
- `apps/web/src/api.ts`, `apps/web/src/connection.ts`
- `apps/desktop/src/main.ts`
- Tests: `auth-security.test.ts`, `app.test.ts`, `browser.test.ts`, `startup.test.ts`, e2e bootstrap/desktop
- Docs: `docs/operations/local-security.md`, README

### Tasks

1. Remove CSRF generation/validation and client header plumbing only.
2. Keep and test Host/Origin rejection cases (wrong Host, disallowed Origin).
3. Keep bootstrap for browser/dev; optional desktop shortcut if it reduces token URL logging.
4. Update e2e specs.
5. Mutating REST still requires authenticated session cookie.

### Validation

```sh
npm run build && npm run lint && npm run check && npm test
npm test -- apps/server/test/auth-security.test.ts apps/server/test/app.test.ts apps/server/test/browser.test.ts apps/server/test/startup.test.ts
npm run test:e2e -- tests/e2e/bootstrap.spec.ts tests/e2e/desktop.spec.ts
```

Plus bounded smoke (§6).

**Manual**

1. Desktop opens UI without manual URL paste.
2. `npm run dev` with `PI_DASH_UI_ORIGIN=http://127.0.0.1:5173` works.
3. Wrong `Host` / disallowed `Origin` rejected.
4. Unauthenticated mutating `curl` fails.
5. Terminal WS connects after session exists.

### Exit criteria

- No CSRF token in session API or client.
- Host/Origin + HttpOnly + SameSite=Strict retained and tested.
- Security docs describe DNS rebinding mitigation accurately.
- Desktop + bootstrap e2e green.

---

## Phase 4b — Desktop log sink slim (after auth)

### Target

Simplify logging **without** ever recording bootstrap tokens, session cookies, or status secrets in plaintext.

### Why after Phase 4

`startup.ts` currently emits a bootstrap-token URL. Until that path is redesigned or tokens are no longer logged, targeted redaction must remain.

### Files

- `apps/desktop/src/daemon-log.ts`
- Tests: `apps/desktop/src/daemon-log.test.ts`
- Caller: `apps/desktop/src/main.ts`
- Related: server startup/bootstrap output

### Target design

- Plain capped/rotating file sink is fine.
- **Must** scrub bootstrap URLs, cookie headers, and status tokens/secrets if they can appear on stdout/stderr.
- Drop only the overbuilt JSON deep secret-key tree **after** proving those values cannot reach the log, or keep a minimal allowlist scrubber forever.

### Validation

```sh
npm test -- apps/desktop
```

Confirm logs never contain `token=`, raw status tokens, or `Set-Cookie` values in fixtures/tests.

### Exit criteria

- Simpler sink landed.
- Secret scrubbing coverage remains for bootstrap/cookie/status secrets **or** those values are proven never logged.

---

## Phase 5 — Database, migrations, and DI cleanup

### Target

Make persistence and daemon wiring match a small local app **without endangering managed worktrees**.

### 5a — Drop Drizzle

**Files:** `apps/server/src/schema.ts`, ORM usage in `database.ts`, package deps.

**Tasks**

1. Move `app_metadata` to raw `better-sqlite3`.
2. Remove Drizzle dependency and ORM schema file.

### 5b — Simplify migrations + DB-only reset

**Target design**

- Use `PRAGMA user_version` (or a single schema version row) and forward SQL.
- Drop checksummed migration journal verification and pre-migration backup + `integrity_check` theater.
- After Phase 2/3, squash to a fresh foundation schema if desired.

**Incompatible schema handling (required — never “delete data dir”)**

`paths.ts` layout reminder:

- `<data>/pi-dash.sqlite` (and related DB files)
- `<data>/worktrees/**` managed worktree checkouts (may contain dirty user work)

On unsupported/old schema:

1. **Refuse to mutate** the DB and refuse to start serving normally.
2. Print a precise recovery procedure, e.g.:
   - Stop Pi Dash.
   - Move/rename **only** the SQLite files (`pi-dash.sqlite`, `-wal`, `-shm`) to a backup path.
   - Restart to create a fresh empty DB.
   - Re-add workspaces by selecting existing repo paths.
   - For directories still under `<data>/worktrees/**`: explain they may be orphaned linked worktrees; operator should inspect with `git worktree list` in the original repo and run `git worktree remove` / prune manually as appropriate.
3. **Never** tell the user to `rm -rf` the data directory.
4. Optional helper later (out of scope unless easy): `pi-dash reset-db --data-dir …` that moves only DB files.

Suggested tables after squash (illustrative):

- `app_metadata`
- `workspaces`
- `worktrees` (lifecycle + tombstone fields; no operation journal)
- `workflow_status` (current status + completionId; no ack revision protocol)

**Files:** `database.ts`, `migrate-cli.ts`, `migrations/**`, `database.test.ts`, contracts schema version, README/ops docs.

### 5c — Flatten DI opportunistically

**Files:** `daemon.ts` and factories for deleted signers.

Keep a single composition root; keep shared `gitCommonDir` lock injection into workspace + worktree services.

### Validation

```sh
npm run build && npm run lint && npm run check && npm test
npm test -- apps/server/test/database.test.ts
# Use an empty temp data dir — do NOT delete a real data dir containing worktrees
mkdir -p /tmp/pi-dash-fresh && npm run db:migrate -- --data-dir /tmp/pi-dash-fresh
```

Tests must assert incompatible DB → clear error mentioning **DB file reset only**, and must not recommend deleting `worktrees/`.

Plus bounded smoke (§6).

### Exit criteria

- No `drizzle-orm`.
- No migration checksum/backup machinery.
- Schema matches simplified worktree/status model.
- Recovery docs/procedure preserve worktrees.
- Daemon boots on a fresh data dir.

---

## Phase 6 — Contracts and ApiErrorCodes

### Target

Stop treating the co-located app like a public versioned API platform, without abandoning untrusted-boundary validation or UI-stable errors.

### 6a — Unwind dual response validation

**Today:** Fastify `schema:` validates requests; web `Value.Check`s every response and fails closed.

**Target**

1. Shared TypeScript types between server and web.
2. Runtime validate **all untrusted inputs**: REST, WS frames, status NDJSON, config, persisted JSON.
3. Web may trust server responses in production (optional dev asserts).
4. Preferred package shape: keep `packages/contracts` exporting types + schemas needed for untrusted boundaries / server inputs.

### 6b — Shrink ApiErrorCodes (UI-stable)

**File:** `packages/contracts/src/index.ts`

Reduce the catalog, but **retain a stable discriminant for every condition that changes UI behavior** (dialogs, disabled actions, badges, sync indicator states, etc.).

Examples of codes that likely remain (illustrative, finalize by inventory):

- `UNAUTHORIZED`, `FORBIDDEN_ORIGIN` (if UI/API distinguishes), `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `INTERNAL_ERROR`
- `GIT_UNAVAILABLE`, `GIT_TIMEOUT`
- `WORKTREE_DIRTY`, `WORKTREE_REMOVE_FAILED`, `WORKTREE_FORCE_BLOCKED` (if UI branches)
- Sync failure codes the indicator still switches on
- `PI_UNAVAILABLE`, `PTY_START_FAILED`
- Status/auth frame errors if UI/server distinguish them

**Messages are presentation only.** Web/server UI logic must not branch on message text.

Delete codes that only existed for removed machinery: idempotency, snapshot tokens, removal confirmation HMAC, status revision ack, CSRF.

### Tasks

1. Inventory `ApiErrorCodes` / UI switches (`rg`).
2. Collapse unused codes; keep UI discriminants.
3. Remove client production response `Value.Check` fail-closed path.
4. Trim contracts tests.
5. Optional: `/api/v1` → `/api` (not required).

### Validation

```sh
npm run build && npm run lint && npm run check && npm test
npm test -- packages/contracts
npm run test:e2e
```

### Exit criteria

- Web does not TypeBox-validate every successful response in production.
- Every UI branch uses a stable error code/discriminant.
- No references to deleted worktree HMAC/idempotency/revision codes.

---

## Phase 7 — Split `App.svelte`

### Target

Improve understanding of critical paths by decomposing the ~1291-line root. Keep the shadcn-svelte kit as registry-shaped source so future `npx shadcn-svelte@latest update` remains practical; do **not** prune unused sidebar/dialog siblings.

### Tasks

Decompose `App.svelte` into feature shells aligned to stores/domains, for example:

- connection/bootstrap shell
- workspace sidebar shell
- worktree/session shell
- terminal host
- diff host
- status subscription host

Follow `STYLE.md`. Prefer move-only extracted components with minimal behavior changes. Do not proactively strip accessibility behavior from shadcn primitives.

### Validation

```sh
npm run build && npm run lint && npm run check && npm test
npm run check -w @pi-dash/web
npm test -- apps/web
```

Manual smoke: sidebar, dialogs, terminal, diff, status badge.

### Exit criteria

- `App.svelte` is a thin composition root (order-of-magnitude smaller).
- No broken imports.
- shadcn `components/ui/**` left intact for updateability.

---

## Phase 8 — Docs, cleanup, final gate

### Target

Repository narrative matches the simplified system; full regression passes.

### Tasks

1. Update README commands/security paragraphs (Host/Origin retained; CSRF gone; multi-root unsupported; DB-only reset).
2. Update or delete obsolete docs:
   - Rewrite: `docs/architecture/worktree-lifecycle.md`, `docs/architecture/status-protocol.md`
   - Replace recovery docs with health refresh + manual orphan cleanup (never delete-data-dir)
   - Rewrite: `docs/operations/local-security.md`, `docs/operations/configuration.md`
   - Trim: status troubleshooting / ask-user integration docs
3. Remove stale stubs/helpers.
4. Grep for dead terms:
   ```sh
   rg -n "idempotency|confirmationToken|baseSnapshot|csrfToken|resyncRequired|APPLICATION_EVENTS_PROTOCOL_VERSION|drizzle|delete the data directory|rm -rf.*data" apps packages docs tests README.md
   ```
   Quarantine **journal** should be gone; mount preflight mentions may remain.
5. Mark checklist below complete.

### Final validation gate (required)

```sh
npm ci
npm run build
npm run lint
npm run check
npm test
npm run test:e2e
```

Plus a **bounded** desktop/browser smoke harness (timeout-capped). Do not rely on interactive unbounded `npm run desktop` as the automated gate.

**End-to-end manual script (30–45 minutes)**

1. Fresh **empty** data dir (not a destructive wipe of an existing worktree-bearing dir).
2. Launch desktop app.
3. Add workspace via native dialog.
4. Create two worktrees.
5. Open terminal on worktree A; trivial Pi prompt; confirm output.
6. Confirm status badge transitions; dismiss done safely.
7. Open diff for dirty files.
8. Sync workspace on a clean ff-only repo; confirm unsafe-config still blocked.
9. Remove clean worktree; complete “Delete merged branch” when applicable.
10. Force-remove dirty worktree with confirmation.
11. Restart app; lists persist; stuck/missing rows visible if simulated.
12. `npm run dev` browser path still authenticates and lists workspaces.
13. Confirm wrong Host/Origin rejected.

### Exit criteria

- Final gate green.
- Docs describe the simplified system only.
- No instructions to delete the whole data directory.
- Grep for removed concepts is clean.

---

## 8. Suggested PR / commit strategy

Prefer **one PR per phase** (or per Phase 1 letter). Do not combine Phase 2 (worktrees) with Phase 6 (contracts) in one review.

Commit message style: focus on why, e.g.

- `remove worktree idempotency ledger and HMAC tokens`
- `replace status cursor protocol with snapshot push`
- `drop CSRF while retaining Host and Origin checks`

Do not amend pushed commits; do not skip hooks.

## 9. Risk register

| Risk | Mitigation |
|---|---|
| Worktree remove deletes wrong path | Full preflight list; refuse when Git identity unproven; prefer `git worktree remove`; verify absence before tombstone |
| Invisible orphans after crash | `creating`/`removing` rows + startup health refresh; required fault-injection tests |
| Branch cleanup UX lost | Explicit tombstone + mergedness check retained |
| Sync executes untrusted repo config | Keep env/hooks/protocol/config guards while thinning taxonomy |
| DNS rebinding | Keep Host/Origin validation; dropping CSRF only |
| Operator deletes dirty worktrees via “reset” | DB-only reset procedure; never delete data dir |
| Terminal/remove race | Keep lifecycle claims |
| Status dismiss races | completionId dismiss semantics |
| Multi-data-root races | Unsupported; document after dropping cross-process flock |
| Auth slim breaks Vite | Test `PI_DASH_UI_ORIGIN=http://127.0.0.1:5173` after Phase 4 |
| Secrets in desktop logs | Phase 4b only after bootstrap redesign; keep scrubbers until then |
| Huge Phase 2 PR | Split create vs remove PRs only if HMAC is fully gone in each merge |

## 10. Out-of-scope follow-ups (optional later)

- Collapse monorepo packages into fewer packages once contracts thin.
- Remove browser launch entirely if Electron-only becomes absolute policy.
- Optional `reset-db` CLI that moves only SQLite files.
- Further terminal protocol simplification (PTY stack is core, not flagged as over-engineering).

## 11. Progress checklist

- [ ] Phase 0 — leftovers deleted (including ignore/lint refs)
- [ ] Phase 1a — diff scheduler simplified
- [ ] Phase 1b — workspace sync taxonomy thinned (execution controls retained)
- [ ] Phase 1c — config trimmed
- [ ] Phase 2 — worktree de-hardened (preflight + lifecycle + tombstone retained)
- [ ] Phase 3 — status snapshot WS + completionId dismiss
- [ ] Phase 4 — CSRF removed; Host/Origin/cookies retained
- [ ] Phase 4b — desktop log sink slimmed safely
- [ ] Phase 5 — DB/DI cleaned; DB-only reset documented
- [ ] Phase 6 — contracts/errors simplified with UI-stable codes
- [ ] Phase 7 — `App.svelte` split
- [ ] Phase 8 — docs + final gate passed

## 12. Definition of done (whole project)

The simplification is complete when all of the following are true:

1. No idempotency ledger, HMAC worktree tokens, quarantine journal, cursor/ack-revision status protocol, or CSRF token flow remains in runtime code.
2. Host/Origin validation, removal preflights, sync execution controls, lifecycle states, tombstone branch cleanup, and `gitCommonDir` locking remain.
3. Status badge works via snapshot WS with stale-frame rejection and safe done dismissal.
4. Drizzle is gone; migrations match the simplified schema; recovery never deletes `worktrees/`.
5. Contracts are types-first at the response layer; untrusted boundaries still validate; UI branches on stable error codes only.
6. `App.svelte` is split; shadcn kit left intact for updates.
7. Phase 8 final gate and manual script pass.
8. Docs no longer instruct operators to recover worktree journals, delete the data directory, or treat the daemon like a public CSRF-hardened web app without mentioning DNS rebinding controls that remain.
