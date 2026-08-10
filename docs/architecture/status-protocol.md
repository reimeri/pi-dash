# Workflow status protocol v1

Pi Dash tracks workflow attention separately from terminal runtime state. Runtime state answers whether Pi is running; workflow state answers whether the user should look at that worktree.

## States

- **idle** — no active agent work and no unread completion.
- **working** — Pi emitted `agent_start` and has not fully settled.
- **blocked** — a cooperating interactive extension emitted an exact `ask_user` wait start and has not emitted its matching end.
- **done** — Pi emitted `agent_settled`; this remains visible until a later selection, terminal focus/click/input, or explicit revision-safe acknowledgement.

Blocked is intentionally narrow. Terminal silence, tool preflight, prompt wording, assistant questions, and arbitrary third-party dialogs are never inferred as blocked. Without a compatible ask-user extension, an agent remains working while it waits.

## Extension side channel

The bundled extension connects only after `session_start` to `<runtime-root>/status.sock`. The runtime directory is user-owned mode `0700`; the socket is mode `0600`. Frames are UTF-8 LF-delimited JSON and are limited to 16 KiB.

Every frame contains protocol version, runtime ID, worktree ID, per-runtime random token, extension-instance UUID epoch, monotonic sequence, and diagnostic timestamp. Event frames contain only lifecycle names, a stable opaque completion UUID for `agent_settled`, and, for exact waits, an opaque interaction UUID and allowlisted `ask_user` reason. Snapshots contain `agentActive` and the complete opaque blocking-interaction set.

Conversation messages, prompt text, answers, system prompts, tool arguments/results, provider credentials, and terminal data are forbidden. The token is used only for side-channel authentication and is never logged or sent to the browser.

A `session_start` installs a new authenticated extension epoch. Sequence ordering is scoped to the active `(runtimeId, extensionInstanceId)`. Duplicate, reordered, retired-epoch, wrong-runtime, wrong-worktree, wrong-token, malformed, oversized, or implausibly timestamped frames are rejected without affecting Pi.

Socket errors are fail-open. The extension uses non-blocking writes, bounded event buffering, reconnects, and a full state snapshot after each connection. It closes resources idempotently on `session_shutdown`.

## Reduction and persistence

The daemon uses receipt time as authoritative `changedAt`. Blocking interactions are a set, so ending one of two overlapping waits remains blocked. `agent_settled` clears transient waits and writes done. Its completion UUID is replayed across reconnects, allowing the daemon to ignore the same completion after it has been acknowledged rather than resurrecting done. Runtime exit resets only working or blocked to idle with `runtime_reset`; done is preserved.

`workflow_status` stores one row per worktree with state, reason, monotonic revision, timestamps, and integration health. Startup resets stale working/blocked rows because PTY runtimes do not survive the daemon. Unacknowledged done rows remain visible.

Acknowledgement is compare-and-set:

```http
POST /api/v1/worktrees/:id/status/acknowledge
Content-Type: application/json
X-CSRF-Token: ...

{ "revision": 17 }
```

A matching done revision becomes idle. A late request receives `409 STATUS_REVISION_CHANGED` and cannot clear newer work.

## Browser event stream

The browser event stream is version 8, independently from the extension side-channel version in this document. Authenticated clients connect to `/api/v1/events/socket` and send:

```json
{ "v": 8, "type": "subscribe", "afterCursor": 410 }
```

The first server frame is always an atomic snapshot with one cursor, all workflow statuses, complete runtime DTOs (including nullable sanitized launch errors), and workspace aggregates. Ordered `status` and `runtime` frames then advance the cursor by one. A gap causes the client to reconnect for a fresh snapshot, avoiding REST/WebSocket races.

Indicators expose textual accessible names and tooltips. Working and blocked animation is disabled under `prefers-reduced-motion`; shape and text still distinguish every state.
