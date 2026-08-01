# Testing

## Test layers

- `npm test` runs Vitest contract, configuration/path, authentication, database/backup, Fastify integration, daemon-lock/lifecycle, and frontend reducer tests.
- `npm run test:e2e` builds all workspaces, launches a production daemon with temporary XDG-style roots, and runs the Chromium bootstrap/dashboard smoke flow.
- `npm run check` runs TypeScript and Svelte diagnostics.
- `npm run lint` and `npm run format:check` enforce source style.

Tests create isolated roots under the system temporary directory and remove them afterward. The E2E suite uses port `4318`; ensure it is free. A local Chrome installation is expected by the Playwright configuration.

## Migration fixtures

A fresh database must reach the schema declared by `CURRENT_SCHEMA_VERSION`. Database integration tests also verify SQLite pragmas, newer-schema rejection, file permissions, and a backup containing writes still present in WAL state. When adding migration `NNNN`:

1. Add the previous-version database fixture without sensitive data.
2. Assert the fixture upgrades to the same schema as a fresh database.
3. Assert a verified `backup-vN-to-vNNNN-*` file is created before the migration.
4. Add failure/transaction rollback coverage for any data transformation.

Never build migration fixtures by copying a live WAL database. Use SQLite's backup API or close/checkpoint the source first.
