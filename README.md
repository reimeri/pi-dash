# Pi Dash

Pi Dash is a Linux-first, local-only Svelte dashboard backed by a loopback Fastify daemon.

## Requirements

- Node.js 24 or newer
- npm 11 or newer
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

See [configuration](docs/operations/configuration.md), [local security](docs/operations/local-security.md), and [testing](docs/testing/README.md).
