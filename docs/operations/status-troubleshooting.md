# Workflow status troubleshooting

Workflow integration is deliberately fail-open: a degraded status channel must never prevent terminal input, Pi lifecycle, or ask-user UI.

## Indicator says integration disconnected

1. Confirm the terminal runtime is running. Runtime and workflow indicators are separate.
2. Confirm `<runtime-root>` is owned by the current user with mode `0700` and `status.sock` exists with mode `0600`.
3. Confirm the launched Pi environment includes `PI_DASH_STATUS_SOCKET`, `PI_DASH_RUNTIME_ID`, `PI_DASH_WORKTREE_ID`, and `PI_DASH_STATUS_TOKEN`. Never print the token value.
4. Verify the configured Pi version supports `session_start`, `session_shutdown`, `agent_start`, `agent_settled`, and `pi.events`.
5. Restart only that worktree runtime. A new runtime UUID/token invalidates the old process safely.

The daemon logs only sanitized rejection codes and runtime IDs at debug level. Tokens and frame bodies are never logged.

## Working never becomes blocked

This is expected unless the active ask-user extension implements the exact shared-event contract. Check [ask-user integration](../integrations/ask-user-status.md). Pi Dash does not inspect terminal output, question wording, quiet time, or `tool_execution_start`.

Ensure start is emitted immediately before the UI await, end is in `finally`, the reason is exactly `ask_user`, and the interaction ID is a UUID. Unsupported reasons are rejected.

## Done does not clear

Done is unread attention, not an idle detector. It remains even if the terminal was already selected when Pi settled. Perform a later terminal selection, click, focus, input, or use **Acknowledge done**.

If acknowledgement returns `STATUS_REVISION_CHANGED`, a newer status arrived. Refresh from the event snapshot and acknowledge the displayed done revision; do not retry an old revision blindly.

## State after crashes or restarts

A runtime exit resets working/blocked to idle with reason `runtime_reset`. Crashed/stopped remains visible in the separate runtime status. Daemon startup also resets stale active workflow states because runtimes are process-local. Unread done survives both cases.

## Browser status channel reconnects

The browser requires an atomic cursor snapshot followed by contiguous events. Malformed data or a cursor gap closes the event socket and requests a fresh snapshot automatically. Terminal WebSockets remain independent and usable during this recovery.
