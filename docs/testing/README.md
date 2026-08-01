# Testing

## Test layers

- `npm test` runs Vitest contract, configuration/path, authentication, database/backup, safe-process, native-dialog, Git inspection, workspace service/API, terminal protocol/ring/environment/process integration, authenticated status-socket framing, workflow reduction/persistence/acknowledgement, application-event cursoring, daemon lifecycle, extension privacy, and frontend store/reducer tests.
- `npm run test:e2e` builds all workspaces, launches production daemons with temporary XDG-style roots, and runs the Chromium bootstrap, workspace/worktree, and fake-Pi terminal/status flows. It also launches Electron and verifies that browser-reserved shortcuts reach the PTY while terminal copy is consumed. The status-capable fake emits only the same lifecycle metadata as the bundled extension.
- `npm run check` runs TypeScript and Svelte diagnostics.
- `npm run lint` and `npm run format:check` enforce source style.

Tests create isolated roots and temporary Git repositories under the system temporary directory and remove them afterward. The E2E suite uses ports `4318`–`4324`; ensure they are free. A local Chrome installation and Linux graphical session are expected by the Playwright configuration and Electron test.

## Migration fixtures

A fresh database must reach the schema declared by `CURRENT_SCHEMA_VERSION`. Database integration tests also verify SQLite pragmas, newer-schema rejection, file permissions, and a backup containing writes still present in WAL state. When adding migration `NNNN`:

1. Add the previous-version database fixture without sensitive data.
2. Assert the fixture upgrades to the same schema as a fresh database.
3. Assert a verified `backup-vN-to-vNNNN-*` file is created before the migration.
4. Add failure/transaction rollback coverage for any data transformation.

Never build migration fixtures by copying a live WAL database. Use SQLite's backup API or close/checkpoint the source first.
