import { loadConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { acquireDaemonLock } from "./lock.js";
import { resolveAppPaths } from "./paths.js";
import { resolveAppResources } from "./resources.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const paths = resolveAppPaths(config);
  const resources = resolveAppResources();
  const lock = acquireDaemonLock(paths.lock);
  try {
    const database = await openDatabase({
      path: paths.database,
      migrationsDirectory: resources.migrations,
    });
    try {
      process.stdout.write(`Schema is at version ${database.schemaVersion}.\n`);
    } finally {
      database.close();
    }
  } finally {
    lock.release();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
