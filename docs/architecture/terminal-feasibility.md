# Terminal feasibility decision record

- **Date:** 2026-08-01
- **Phase:** 0 — Terminal and Pi feasibility
- **Decision:** **PROCEED**
- **Scope:** Linux/Chromium, one Pi PTY, one browser terminal, bounded replay, and a private lifecycle socket

## Decision

The production architecture can proceed with the planned Svelte 5 + `@battlefieldduck/xterm-svelte` + custom WebSocket + `node-pty` design. Real Pi 0.83.0 rendered its header, transcript, editor, footer, selectors, tools, installed extensions, and extension-provided custom UI correctly in xterm.js. Browser disconnect did not stop Pi. Bounded replay plus a forced resize restored a usable real ask-user selector, including across a refresh while blocked.

Three findings are requirements for the production terminal component:

1. Capture Shift+Enter and Alt+Enter on the terminal host during the DOM capture phase, stop the browser event, and send explicit CSI-u (`ESC [ 13 ; 2 u` / `ESC [ 13 ; 3 u`) frames. An initial xterm custom-key-handler attempt still allowed Enter normalization soon enough to submit; capture-phase translation produced Pi's newline and follow-up semantics exactly once.
2. Set xterm's `allowProposedApi` while using Unicode11Addon with xterm 6. Without it, selecting Unicode version 11 throws and prevents FitAddon/ResizeObserver setup.
3. Never rely on xterm-svelte to own teardown. Dispose the observer, addons, terminal, timers, and WebSocket explicitly. The wrapper creates the terminal but does not include a component teardown path in version 2.3.0.

No tmux, headless xterm snapshot, or SerializeAddon is required by the evidence from this spike. The selected bounded recovery design is: sequence-numbered byte replay, an explicit reset when the requested sequence was evicted, replay of the available suffix, and a one-column resize nudge followed by restoration. Phase 4 should retain this design and its tests. A server-side snapshot should be reconsidered only if later Pi versions produce a reproducible redraw failure.

## Test environment

| Item | Observed version |
|---|---|
| Distribution | Arch Linux rolling, build `20260524.0.535079` |
| Desktop/session | niri on Wayland |
| Browser | Google Chrome 151.0.7922.71, headless for automation |
| Node.js / npm | 24.16.0 / 11.13.0 |
| Git | 2.55.0 |
| Pi | 0.83.0 |
| Svelte | 5.55.7 |
| `@battlefieldduck/xterm-svelte` | 2.3.0 |
| `@xterm/xterm` | 6.0.0 |
| FitAddon / Unicode11Addon | 0.11.0 / 0.9.0 |
| `node-pty` | 1.1.0 |
| Fastify / WebSocket plugin | 5.11.0 / 11.3.0 |
| Playwright | 1.58.2 |

Firefox was not exercised and remains a useful secondary Phase 4 check. The required Chromium target passed.

## Measured results

Measurements were taken on localhost with terminal content logging disabled.

| Requirement | Result | Evidence |
|---|---:|---|
| Fake-PTY input-to-echo latency | **0.44 ms p95** | 20 sequential unique inputs over the JSON WebSocket |
| Reconnect usable time | **95.3 ms** | Full refresh through replay/redraw plus successful post-reconnect input; budget 2 s |
| High output | **5 MiB/s for 30 s passed** | 150 MiB reached the server in 30.036 s and rendered completion in 30.142 s; an in-page 100 ms heartbeat peaked at 101.7 ms and maximum focus-control latency was 31.8 ms |
| Repeated lifecycle | **100 cycles passed** | 0 terminals, sockets, observers, addons, xterm DOM instances, and host key listeners after final unmount |
| Retained browser heap | **0.997× baseline** | Forced GC after warmup and 100 cycles; budget <1.10× |
| Output memory bound | **passed** | Ring stayed at or below configured cap and rejected stale replay |
| Daemon cleanup | **passed** | SIGTERM path and `/quit` left no child or Unix socket in integration checks |
| npm security audit | **no high findings** | One low esbuild advisory affects a Windows development-server path; this Linux spike serves a production build |

Absolute browser heap values in the final run were 6,865,172 bytes before and 6,841,515 bytes after the lifecycle loop. These are diagnostic measurements, not a stable product benchmark.

## Real Pi matrix

| Action | Result | Observation |
|---|---|---|
| Startup and ordinary TUI | Pass | Header, context/extensions, transcript, editor, footer, model, branch, and token state were legible |
| `/model` | Pass | Model selector drew and canceled correctly |
| `/settings` | Pass | Searchable settings list drew and canceled correctly |
| `/tree` | Pass | Session tree drew, navigated, and restored the editor |
| Enter | Pass | Submitted once |
| Shift+Enter | Pass | Capture-phase CSI-u inserted a second editor line without submitting |
| Alt+Enter | Pass | Capture-phase CSI-u displayed Pi's `Follow-up:` queued-message row during an active run; both runs settled |
| Escape / Ctrl+C | Pass | Cancel/abort and clear behavior remained in Pi rather than the page |
| Ctrl+O / Ctrl+T / Ctrl+L | Pass | Tool expansion, thinking display, and model selector shortcuts remained functional |
| Arrows / Tab / Backspace | Pass | Editing, selector navigation, completion, and deletion remained functional |
| Unicode | Pass | `λ` and wide `界` aligned in editor and free-text UI with Unicode 11 active |
| Multiline paste | Pass | A browser ClipboardEvent reached xterm bracketed-paste handling and produced two editor lines without per-line submission |
| Ask-user selector | Pass | `/spike-ask` rendered listed options and free text; start was emitted immediately before await and end in `finally` |
| Refresh while blocked | Pass | Pi PID was unchanged, status remained blocked, selector redrew, and answer submission completed |
| Agent lifecycle | Pass | A guarded real-model run showed `working` at `agent_start` and `done` at `agent_settled` |
| Resize | Pass | FitAddon sent positive dimensions; real Pi and fake alternate screen redrew cleanly |
| `/quit` | Pass | Runtime changed to `exited (0)` while the WebSocket remained able to show final state |

The headless browser cannot perform a trusted physical OS clipboard gesture, so automation dispatched the same browser `ClipboardEvent` consumed by xterm. The xterm/Pi bracketed-paste path passed; a physical Ctrl+Shift+V smoke remains sensible on each packaged desktop target.

## Status side channel

The bundled extension starts only on `session_start`, sends no terminal text, and closes idempotently on `session_shutdown`. Frames are LF-delimited JSON and require both the random runtime ID and 256-bit token. A wrong token was rejected. The reducer correlates blocking interactions by ID, does not infer blocked state from tool preflight, and clears transient interactions on settle/shutdown.

The compatible `/spike-ask` fixture demonstrated the shared event contract:

1. emit `pi-dash:attention { phase: "start", interactionId, reason: "ask_user" }`;
2. await the terminal selector/input;
3. emit the matching `end` in `finally`.

A socket failure or absent environment leaves Pi usable. Reconnect sends a non-content state snapshot as lifecycle events; prompt, tool arguments/results, credentials, and terminal bytes never enter the side channel.

## Reliability and security observations

- Fastify binds only to IPv4 or IPv6 loopback; non-loopback options are rejected.
- Pi is resolved and launched directly with an argv array. No shell is involved.
- The selected cwd must resolve to exactly a Git top level before the PTY starts.
- Browser code cannot select an executable or command. The only alternate process is the fixed `--fixture` script selected at daemon startup.
- WebSocket payloads, status lines, resize dimensions, Base64, and replay sequences are bounded and validated.
- Browser disconnect only detaches presentation. Each connection is held behind an atomic replay gate; live output starts only after replay reaches a fixed cutoff.
- Server WebSocket buffering is capped at 4 MiB and a slow client is detached for replay. The browser independently caps its pending xterm write queue at 16 MiB and reconnects from the last applied sequence on overflow.
- Daemon shutdown captures `/proc` PID/start-time identities while the PTY leader is owned, sends SIGTERM to that verified process group, and escalates only the same captured identities to SIGKILL. A SIGTERM-ignoring descendant fixture verified cleanup after the leader had already exited without signaling a reused PID.
- Diagnostics omit terminal data and all secrets.
- Rebuilding client assets under a running spike is unsupported; restart `dev` after changes. This is a disposable harness limitation, not a production contract.

## Automated coverage

`npm run test` runs 17 protocol, ring-buffer, reducer, key-translation, degraded-status, replay-ordering, process-tree, and real-node-pty integration tests. `npm run test:e2e` runs the Chrome fake-PTY flow, including resize, usable reconnect, status, 5 MiB/s for 30 seconds, 100 mount/unmount cycles, heap/resource assertions, and exit reporting. Build, Svelte check, ESLint, Vitest, and Playwright all passed on the environment above.

## Go/no-go conclusion

**GO — Phase 1 may begin.** The defining terminal integration, custom extension UI, lifecycle side channel, reconnect strategy, direct Pi launch, and explicit resource ownership are feasible. Phase 4 must carry forward capture-phase modified-Enter translation, `allowProposedApi` for Unicode 11, explicit xterm teardown, and the tested replay/reset/resize recovery contract.
