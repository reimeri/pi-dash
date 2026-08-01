# Pi Dash

Pi Dash is a Linux-first, local-only Svelte dashboard backed by a loopback Fastify daemon.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Git
- Pi 0.83.0 or newer (configurable)
- Native build prerequisites for `node-pty` (C/C++ toolchain and Python)
- `zenity` (preferred) or `kdialog` in a Linux graphical session for native workspace selection
- A Linux graphical session for the Electron desktop window
- Chrome/Chromium for browser tests

## Commands

```sh
npm ci
npm run desktop      # build and launch the Electron desktop application
npm run dev          # browser-based UI development only
npm run prod         # serve the SPA from Fastify for headless/testing use
npm run db:migrate -- --data-dir "$(mktemp -d)"
npm run build
npm run lint
npm run check
npm test
npm run test:e2e
```

Use `npm run desktop` for normal interactive use. The desktop host removes browser accelerators, disables DevTools, and runs the loopback daemon with the system Node.js executable so native PTY/database modules retain their Node ABI. Set `PI_DASH_NODE_EXECUTABLE` only when `node` is not available on `PATH`; the replacement must be Node.js 24+ and ABI-compatible with the installation used by `npm ci`.

The standalone daemon remains available for development and automation. It opens a short-lived, one-use launch URL in the default browser and also prints it as a fallback. Browser tabs cannot support every Pi keybinding; use the desktop application for terminal interaction. Do not share or persist the launch URL.

See [configuration](docs/operations/configuration.md), [terminal runtime](docs/operations/terminal-runtime.md), [terminal protocol](docs/architecture/terminal-protocol.md), [workflow status protocol](docs/architecture/status-protocol.md), [ask-user integration](docs/integrations/ask-user-status.md), [status troubleshooting](docs/operations/status-troubleshooting.md), [native directory dialog](docs/operations/native-directory-dialog.md), [local security](docs/operations/local-security.md), and [testing](docs/testing/README.md).
