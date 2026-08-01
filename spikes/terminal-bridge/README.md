# Terminal bridge feasibility spike

Disposable Phase 0 harness for one browser, one xterm-svelte terminal, one Fastify process, one node-pty process, and one private Pi lifecycle socket.

## Prerequisites

- Linux, Node.js 22 or newer, npm, and Git.
- A `pi` executable with a configured model for the guarded real-Pi checks.
- Google Chrome/Chromium for Playwright. The checked-in config uses the installed `chrome` channel.
- A path that is exactly a Git repository top level. Nested directories are intentionally rejected.

## Install and run

```bash
npm --prefix spikes/terminal-bridge ci
npm --prefix spikes/terminal-bridge run dev -- --cwd /absolute/git/top-level
```

Open <http://127.0.0.1:4173>. Override the executable or port when needed:

```bash
npm --prefix spikes/terminal-bridge run dev -- \
  --cwd /absolute/git/top-level \
  --pi /absolute/path/to/pi \
  --port 4173
```

`dev` builds the Svelte client and starts Fastify. Re-run it after changing the client; this deliberately small spike does not run a hot-reload server. `--fixture` launches the fixed fake terminal instead of Pi. It does not accept a browser-supplied command or arbitrary command arguments.

## Automated checks

```bash
npm --prefix spikes/terminal-bridge run test
npm --prefix spikes/terminal-bridge run check
npm --prefix spikes/terminal-bridge run test:e2e
npm --prefix spikes/terminal-bridge run lint
npm --prefix spikes/terminal-bridge run build
```

The end-to-end test starts the fake PTY itself. It covers Unicode input, modified Enter translation, a multiline paste event, resize, browser refresh/replay, status transitions, 5 MiB/s output for 30 seconds, 100 mount/unmount cycles, process-tree exit, and resource counters.

## Real-Pi checklist

1. Start without `--fixture`; verify the Pi header, transcript, editor, footer, and installed extension list.
2. Open `/model`, `/settings`, and `/tree`; navigate with arrows and cancel with Escape or Ctrl+C.
3. Run `/spike-ask`; choose both a listed answer and the free-text path. The dashboard status must be `blocked` only while the dialog is awaiting input.
4. Refresh while `/spike-ask` is open. The PID must remain unchanged and the dialog must still accept an answer.
5. Check Enter, Shift+Enter, Alt+Enter while an agent is active, Escape, Ctrl+C, Ctrl+O, Ctrl+T, Ctrl+L, arrows, Tab, Backspace, and Unicode.
6. Paste multiline text into the xterm input and verify that Pi receives bracketed paste rather than a submission per line.
7. Resize the browser repeatedly and verify the footer and editor redraw without accumulated artifacts.
8. Run `/quit`; verify `exited (0)` remains visible. Stop the daemon and check that no Pi child or status socket remains.

Use the **Focus terminal** button for a keyboard-only focus path. The terminal boundary has an accessible label and a visible `:focus-within` outline.

## Protocol and diagnostics

The disposable JSON protocol is defined in `src/protocol.ts`. Output frames have monotonic sequence numbers. A bounded ring supports replay; stale clients receive `replayReset`, clear local terminal state, replay the available suffix, and receive a PTY resize nudge to force a Pi redraw.

`GET /spike/diagnostics` reports process state, dimensions, sequence/buffer counters, resource counts, status capability, and dependency versions. It never returns terminal bytes, environment secrets, the status token, or prompt content.

The status extension opens its socket only on `session_start`, authenticates every LF-delimited frame with the runtime ID and random token, sends lifecycle/attention events, reconnects with a state snapshot, and fails open if the socket is absent. `/spike-ask` emits `pi-dash:attention` immediately before awaiting terminal UI and emits the correlated end event in `finally`.

See `../../docs/architecture/terminal-feasibility.md` for measurements and the architecture decision.
