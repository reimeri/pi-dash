# Local security model

Pi Dash is a single-user desktop application. It runs local-only by default and can optionally add private, identity-gated browser access through Tailscale Serve while the desktop application is running.

- The daemon binds only to a numeric loopback address and validates every `Host` header to resist DNS rebinding.
- Browser `Origin` values must match the daemon origin or the explicitly configured loopback development UI origin.
- A 256-bit bootstrap token expires after five minutes and is consumed by its first successful exchange.
- The exchange sets an `HttpOnly`, `SameSite=Strict`, path-wide session cookie. Sessions and CSRF tokens exist only in daemon memory and disappear on restart.
- Protected APIs use the same session, Host, and Origin policy exposed by `authenticateUpgrade()` for future WebSockets. State-changing JSON calls additionally require the session CSRF token.
- Bootstrap responses are `no-store` and `no-referrer`. Failed launch pages replace their token-bearing URL before displaying guidance; successful exchanges redirect to a clean URL.
- Logs redact cookies, authorization values, session/CSRF/bootstrap fields, and token query parameters. Health and browser errors omit local filesystem paths.
- Data ownership is protected by a kernel `flock`; stale lock metadata is ignored only after the process acquires the OS lock.
- The Electron renderer is sandboxed without Node integration or DevTools. Navigation and new windows are denied outside the authenticated loopback origin. A sender-validated preload bridge exposes native clipboard writes only to the trusted main frame.
- Electron spawns the daemon with the system Node.js executable, consumes the bootstrap URL without logging it, and holds a private ownership pipe open for the daemon lifetime. The daemon shuts down when that pipe reaches EOF after normal or abnormal Electron exit; Electron also sends SIGTERM during orderly shutdown.
- The shell terminal is an intentional arbitrary-command surface for the local authenticated user. Its API selects only the managed worktree; the executable comes from the daemon user's validated `$SHELL` with `/bin/sh` fallback, and no API accepts command strings, executable paths, arguments, working directories, or environment overrides.
- Shell environments remove every inherited `PI_DASH_*` credential. Foreground-command indicators use Linux process metadata and expose no command text, arguments, PID, or terminal content.
- Workspace environment values are read only by the daemon and injected directly into terminal processes. Values are not stored in SQLite, copied into worktrees, returned through APIs/events, or logged. Optional private-source paths are metadata and are stored in SQLite.
- Environment sources are opened without following a final symlink and must be regular files. Their ownership and write permissions are not restricted because Pi Dash assumes a personal, trusted machine. Every user and process able to modify a source must be trusted because its values can influence runtimes launched as the daemon user. Dotenv text is parsed as data and is never sourced or evaluated by a shell.
- Every Pi agent, shell, and child process for a workspace can read its injected variables. Managed branches must therefore be trusted with those secrets. Same-account processes may also inspect process environments.

The optional bootstrap output file contains a live secret. It is mode `0600`, should be used only by launch/test automation, and is removed during graceful shutdown. Anyone with the same Unix-account privileges can inspect this process and its files; Unix account isolation remains the outer trust boundary.

Generic TLS termination, public access, application user accounts, arbitrary reverse proxies, and multi-user hosting remain unsupported. The only supported remote mode is the documented [local-plus-Tailscale deployment](remote-access.md): the daemon stays on numeric loopback, Electron remains local, Serve supplies HTTPS/WSS and authenticated identity headers, and every remote request or WebSocket upgrade must match an exact configured login. Remote sessions use `HttpOnly`, `Secure`, `SameSite=Strict` cookies, retain CSRF checks, and expire after 12 hours. Tailscale Funnel, tunnels, container publish rules, and other reverse proxies are unsupported.
