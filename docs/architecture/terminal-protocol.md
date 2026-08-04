# Terminal protocol v1

Pi Dash exposes authenticated Pi and shell WebSockets per managed worktree at `/api/v1/worktrees/:id/terminal/socket` and `/api/v1/worktrees/:id/shell-terminal/socket`. Both use the same bounded protocol and independent runtime/output state. The browser must already hold the HttpOnly dashboard session cookie and send an allowed same-origin `Origin`; Host and worktree authorization are checked before attachment. WebSocket compression is disabled and the configured payload limit is enforced by both the upgrade server and frame parser.

All application frames are JSON text with `v: 1`. Raw WebSocket binary frames are rejected. Binary terminal reports use canonical Base64 in `binaryInput`, preserving every byte without treating it as text.

## Attachment and ownership

The first client frame must be:

```json
{ "v": 1, "type": "attach", "afterSeq": 0 }
```

The daemon responds with `hello`, including the current `RuntimeDto`, connection ID, input-owner flag, and replay bounds. The first attached client owns input and resize. Later clients are observers and receive `NOT_INPUT_OWNER` for writes. Browser disconnect only removes the presentation client; it never stops Pi or the shell. Input takeover is deferred to Phase 6.

## Output and replay

Each PTY data callback creates one output chunk with a monotonically increasing sequence:

```json
{ "v": 1, "type": "output", "seq": 42, "data": "...", "replay": false }
```

The daemon retains a bounded suffix by UTF-8 bytes and chunk count. Attachment replays chunks after `afterSeq` behind an atomic live-output gate. If the requested sequence has expired, the server sends `replayReset`, replays the available suffix, and nudges the PTY width by one column before restoring it so alternate-screen terminal UI redraws. The browser resets xterm before applying that suffix. Output is passed to `terminal.write` unchanged.

A socket whose outbound `bufferedAmount` exceeds the configured limit is closed with code 1013; it may reconnect and replay. The browser independently caps pending renderer output at 16 MiB and reconnects from its last applied sequence.

## Client frames

- `attach { afterSeq }` — attach once and request replay after a non-negative safe sequence.
- `input { data }` — UTF-8/xterm input from `onData`, forwarded exactly once.
- `binaryInput { dataBase64 }` — byte-safe xterm reports from `onBinary`.
- `resize { cols, rows }` — owner-only dimensions, columns 2–500 and rows 1–300.
- `ping { nonce }` — application heartbeat, answered by `pong`.

Invalid schema, dimensions, Base64, protocol versions, oversized frames, and pre-attach actions return a stable error and may close the socket with the corresponding WebSocket protocol code.

## Server frames

- `hello { runtime, connectionId, inputOwner, earliestSeq, latestSeq }`
- `output { seq, data, replay }`
- `replayReset { earliestSeq, latestSeq }`
- `runtime { state, exitCode, signal }`
- `pong { nonce }`
- `error { code, message }`

Terminal content, input, provider credentials, status tokens, shell command text, process IDs, and shell arguments are never logged or returned by diagnostics. Shell foreground activity is published separately as a boolean application event so sidebar indicators remain accurate while the terminal pane is detached.
