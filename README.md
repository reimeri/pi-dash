# Pi Dash

Pi Dash is a Linux-first, local-only Svelte dashboard backed by a loopback Fastify daemon.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
- Git
- Pi 0.83.0 or newer (configurable)
- Native build prerequisites for `node-pty` (C/C++ toolchain and Python)
- `zenity` (preferred) or `kdialog` in a Linux graphical session for native workspace selection
- Chrome/Chromium for browser tests

## Commands

```sh
npm ci
npm run dev          # Fastify on 127.0.0.1:4317 and Vite on 127.0.0.1:5173
npm run prod         # build, then serve the SPA from Fastify
npm run db:migrate -- --data-dir "$(mktemp -d)"
npm run build
npm run lint
npm run check
npm test
npm run test:e2e
```

The daemon prints a short-lived, one-use launch URL. Open that URL to establish the browser session; do not share or persist it.

See [configuration](docs/operations/configuration.md), [terminal runtime](docs/operations/terminal-runtime.md), [terminal protocol](docs/architecture/terminal-protocol.md), [workflow status protocol](docs/architecture/status-protocol.md), [ask-user integration](docs/integrations/ask-user-status.md), [status troubleshooting](docs/operations/status-troubleshooting.md), [native directory dialog](docs/operations/native-directory-dialog.md), [local security](docs/operations/local-security.md), and [testing](docs/testing/README.md).
