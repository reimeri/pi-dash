# Terminal runtime operations

Selecting a ready, healthy managed worktree lazily starts Pi directly under a `node-pty` pseudoterminal with that worktree as its exact working directory. The top-bar terminal button also opens a separate shell runtime in a right sidebar. The shell executable is fixed from the daemon user's absolute, executable `$SHELL` path with `/bin/sh` as a validated fallback; browser requests cannot choose an executable, arguments, environment, or working directory. One daemon owns at most one Pi runtime and one shell runtime per worktree.

## Requirements

- Linux, Node.js 24+, and the native build prerequisites needed by `node-pty` (a working C/C++ toolchain, Python, and platform PTY headers).
- Pi **0.83.0 or newer** by default. Configure the executable and minimum version when using another installation.
- A ready, healthy Pi Dash managed worktree.
- User Pi credentials/settings in their normal HOME/XDG locations.

Pi receives the packaged no-op dashboard extension with `--extension`. Phase 5 adds lifecycle status transport at that same path without changing the launch contract. Pi Dash does not override Pi's agent/session directories, theme, tools, approvals, trusted project resources, or login/trust prompts.

## Desktop keyboard behavior

Use the Electron desktop application for interactive Pi terminals. A normal browser tab reserves combinations such as `Ctrl+W` and cannot provide Pi's complete keymap. The desktop host removes native menu accelerators and disables DevTools so xterm receives those keys.

- Pi's control bindings, including `Ctrl+W`, `Ctrl+L`, `Ctrl+T`, `Ctrl+O`, `Ctrl+G`, `Ctrl+P`, `Ctrl+K`, `Ctrl+C`, `Ctrl+D`, and `Ctrl+Z`, are forwarded to the PTY.
- `Shift+Ctrl+P`, `Shift+Enter`, and `Alt+Enter` use CSI-u sequences so Pi can distinguish their modifiers.
- `Shift+Tab` and `Alt+Up` use their standard terminal escape sequences.
- `Ctrl+Shift+C` copies the current xterm selection and does nothing when there is no selection. It never opens DevTools.
- `Ctrl+V` is intentionally left on the existing Pi image/text paste path.

Linux desktop or compositor-level global shortcuts remain outside application control and must not overlap Pi bindings.

## Lifecycle

Runtime states are `stopped`, `starting`, `running`, `stopping`, and `crashed`. A clean `/quit` is stopped; an unexpected nonzero exit is crashed. Exit code and signal remain visible until a start/restart replaces the runtime.

- **Start** is resource-idempotent; concurrent requests return the sole runtime.
- **Stop** is idempotent. Linux stop captures owned process identities, sends SIGTERM, waits for the configured grace interval, then safely escalates exact surviving identities to SIGKILL. Pi is tracked by process group; interactive shell jobs are tracked across the shell's PTY session because foreground jobs use separate process groups.
- **Restart** requires a UUID `Idempotency-Key`; daemon-lifetime retries return the original operation and changed-input reuse fails.
- Hiding, switching away, evicting a browser pane, or refreshing does not stop Pi or the shell. Selecting another worktree closes the shell sidebar without terminating its session.
- Diff and shell right panels are mutually exclusive on desktop and mobile.
- Worktree removal first claims `removing`, awaits disposal of both terminal kinds, then performs Git removal.
- Daemon shutdown drains every runtime. Runtime processes do not survive daemon restart.
- The sidebar worktree row shows a terminal indicator only while the shell PTY has a foreground job. Detection uses Linux terminal process-group metadata and never parses or reports command text.

## Environment

Pi and the shell inherit the user's ordinary environment, including HOME, PATH, SHELL, locale, XDG locations, SSH agent, and provider credentials. Pi Dash then loads `<registered-repository>/.env` when it exists and applies an optional workspace private override file. Private values override repository values; workspace values override inherited values. No environment file is created in a managed worktree.

Environment sources use dotenv assignment syntax without shell evaluation or variable expansion. Sources must be regular files owned by the daemon user, cannot be writable by another user, and cannot define `PI_DASH_*` names. A configured source that is unreadable or invalid blocks runtime startup rather than launching with a partial environment.

Every inherited `PI_DASH_*` value is removed. Only Pi receives these per-runtime status values:

- `PI_DASH_STATUS_SOCKET`
- `PI_DASH_RUNTIME_ID`
- `PI_DASH_WORKTREE_ID`
- `PI_DASH_STATUS_TOKEN`

Pi Dash checks effective environment values while running. When they change, the dashboard persistently identifies runtimes using older values and offers a confirmed restart action. Restarting terminates each affected process tree; foreground shell commands are called out before confirmation. Source contents, status tokens, and terminal bytes are never logged or returned through the environment configuration API.

## Recovery and troubleshooting

**PI_UNAVAILABLE** — verify `pi --version` works for the daemon user, or set `PI_DASH_PI_EXECUTABLE`/`--pi-executable` to an executable path.

**PI_VERSION_UNSUPPORTED** — upgrade Pi or deliberately lower the configured minimum only after validating its TUI against the terminal feasibility checklist.

**ENVIRONMENT_SOURCE_INVALID** — inspect the workspace Environment card. Restore or correct the source, ensure it is a normalized absolute regular-file path owned by the daemon user, and remove write access for other users.

**PTY_START_FAILED** — verify native `node-pty` installation, worktree permissions, executable permissions, and available PTYs. Reinstall dependencies after installing native build prerequisites.

**WORKTREE_NOT_READY / WORKTREE_UNHEALTHY** — reconcile the managed worktree and restore its exact Git identity before starting Pi.

**Replay buffer wrapped** — the pane resets, replays the retained suffix, and requests a Pi redraw. Scrollback older than the configured memory buffer is intentionally unavailable.

**Observer only** — another attached browser owns input. Close the owner and reconnect; explicit takeover UX arrives in Phase 6.

## Limitations

Runtimes are local and daemon-lifetime only. There is no tmux persistence, remote/SSH/container runtime, browser-selected executable, durable terminal history, semantic parsing of terminal output, or guaranteed browser image protocol. Background jobs do not activate the foreground-command indicator. Linux/Chromium is the validated baseline; default xterm rendering does not require WebGL.
