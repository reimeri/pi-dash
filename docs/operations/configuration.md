# Configuration

Configuration precedence is **CLI → environment → JSON file → defaults**. The default file is `$XDG_CONFIG_HOME/pi-dash/config.json` (falling back to `~/.config/pi-dash/config.json`). A CLI or environment config-directory override selects the file location.

| Setting                      | CLI                                    | Environment                                  | JSON key                         | Default                                         |
| ---------------------------- | -------------------------------------- | -------------------------------------------- | -------------------------------- | ----------------------------------------------- |
| Bind host                    | `--host`                               | `PI_DASH_HOST`                               | `host`                           | `127.0.0.1`                                     |
| Port                         | `--port`                               | `PI_DASH_PORT`                               | `port`                           | `4317`                                          |
| Data root                    | `--data-dir`                           | `PI_DASH_DATA_DIR`                           | `dataDir`                        | `$XDG_DATA_HOME/pi-dash`                        |
| Config root                  | `--config-dir`                         | `PI_DASH_CONFIG_DIR`                         | —                                | `$XDG_CONFIG_HOME/pi-dash`                      |
| Runtime root                 | `--runtime-dir`                        | `PI_DASH_RUNTIME_DIR`                        | `runtimeDir`                     | `$XDG_RUNTIME_DIR/pi-dash`, or `<data>/runtime` |
| Pi executable                | `--pi-executable`                      | `PI_DASH_PI_EXECUTABLE`                      | `piExecutable`                   | `pi`                                            |
| Minimum Pi version           | `--pi-minimum-version`                 | `PI_DASH_PI_MINIMUM_VERSION`                 | `piMinimumVersion`               | `0.83.0`                                        |
| Initial terminal columns     | `--terminal-initial-cols`              | `PI_DASH_TERMINAL_INITIAL_COLS`              | `terminalInitialCols`            | `100`                                           |
| Initial terminal rows        | `--terminal-initial-rows`              | `PI_DASH_TERMINAL_INITIAL_ROWS`              | `terminalInitialRows`            | `30`                                            |
| Replay buffer bytes          | `--terminal-output-buffer-bytes`       | `PI_DASH_TERMINAL_OUTPUT_BUFFER_BYTES`       | `terminalOutputBufferBytes`      | `1048576`                                       |
| Maximum terminal frame bytes | `--terminal-max-frame-bytes`           | `PI_DASH_TERMINAL_MAX_FRAME_BYTES`           | `terminalMaxFrameBytes`          | `65536`                                         |
| Maximum socket backlog bytes | `--terminal-max-socket-buffered-bytes` | `PI_DASH_TERMINAL_MAX_SOCKET_BUFFERED_BYTES` | `terminalMaxSocketBufferedBytes` | `4194304`                                       |
| Stop grace milliseconds      | `--terminal-stop-grace-ms`             | `PI_DASH_TERMINAL_STOP_GRACE_MS`             | `terminalStopGraceMs`            | `2000`                                          |
| Mounted terminal cache size  | `--terminal-cache-size`                | `PI_DASH_TERMINAL_CACHE_SIZE`                | `terminalCacheSize`              | `3`                                             |
| Native dialog                | `--native-dialog`                      | `PI_DASH_NATIVE_DIALOG`                      | `nativeDialog`                   | `auto`                                          |
| Log level                    | `--log-level`                          | `PI_DASH_LOG_LEVEL`                          | `logLevel`                       | `info`                                          |
| UI origin                    | `--ui-origin`                          | `PI_DASH_UI_ORIGIN`                          | `uiOrigin`                       | daemon origin                                   |
| Static assets                | `--static-dir`                         | `PI_DASH_STATIC_DIR`                         | `staticDir`                      | `apps/web/dist`                                 |
| Launch URL file              | `--bootstrap-output`                   | `PI_DASH_BOOTSTRAP_OUTPUT`                   | `bootstrapOutput`                | unset                                           |

Only numeric loopback addresses are accepted. `0.0.0.0`, LAN addresses, and hostnames are rejected. `uiOrigin` is intended for the loopback Vite development server and must also be an HTTP loopback origin.

Directories are created with mode `0700`; the database, lock metadata, runtime metadata, persistent snapshot-signing key, and optional launch URL file use mode `0600`. The workflow status side channel has no independent setting: it uses `<runtime-root>/status.sock` with mode `0600`, a fixed 16 KiB lifecycle-frame limit, and per-runtime credentials injected only into the managed Pi process.

Managed worktrees are always allocated beneath `<data>/worktrees/<workspace-id>/<worktree-id>-<slug>`; this root is not independently configurable. Base-ref snapshot tokens are HMAC-signed with `<data>/.snapshot-signing-key`, so unexpired forms survive daemon restarts. Git mutation locks deliberately do not use the configurable data or runtime roots: related repositories serialize through `/run/user/<uid>/pi-dash-git-locks`, with a user-owned mode-`0700` `/tmp/pi-dash-<uid>` fallback.

Terminal dimensions are constrained to 2–500 columns and 1–300 rows. Workflow status transport is independent from terminal output and never parses it; see [workflow status protocol](../architecture/status-protocol.md) and [status troubleshooting](status-troubleshooting.md). Replay is configurable from 64 KiB to 16 MiB, socket backpressure from 64 KiB to 16 MiB, frame size from 1 KiB to 1 MiB, stop grace from 100 ms to 30 seconds, and browser terminal cache size from 1 to 12. See [terminal runtime operations](terminal-runtime.md) and [terminal protocol](../architecture/terminal-protocol.md).

`nativeDialog` accepts `auto`, `zenity`, `kdialog`, or `disabled`. `auto` prefers zenity and falls back to kdialog. A picker also requires a graphical display session; when probing fails, the workspace flow offers typed-path recovery rather than a generic directory browser. See [native directory dialog](native-directory-dialog.md).

## Migrations

Ordered forward migrations live in `migrations/NNNN_name.sql`. The numeric sequence must be contiguous and must match `CURRENT_SCHEMA_VERSION` in `packages/contracts`. Applied names and SHA-256 checksums are stored in `migration_journal`.

Before each upgrade of an existing schema, the runner uses SQLite's backup API and verifies the resulting database with `PRAGMA integrity_check`. Rollback means stopping the daemon and restoring a verified backup; the application never performs an automatic downgrade or a live database-file copy.

Database rollback cannot undo Git worktrees or branches created after the backup. Reconcile and remove managed worktrees with the newer application, verify Git state, and only then restore an older backup. See [managed worktree recovery](worktree-recovery.md).
