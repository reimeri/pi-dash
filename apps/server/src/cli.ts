import { createDaemon } from "./daemon.js";
import { listenAndLaunchDashboard } from "./startup.js";

process.on("uncaughtExceptionMonitor", (error, origin) => {
  const detail = error.stack ?? `${error.name}: ${error.message}`;
  process.stderr.write(`pi-dash fatal ${origin}: ${detail}\n`);
});

async function main(): Promise<void> {
  const daemon = await createDaemon();
  let stopping: Promise<void> | undefined;
  const stop = (signal: NodeJS.Signals): Promise<void> => {
    if (!stopping) {
      daemon.app.log.info({ signal }, "Shutting down");
      stopping = daemon.shutdown();
    }
    return stopping;
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    void stop(signal).catch((error: unknown) => {
      process.stderr.write(
        `pi-dash shutdown failed: ${(error as Error).message}\n`,
      );
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  try {
    await listenAndLaunchDashboard(daemon);
  } catch (error) {
    await daemon.shutdown();
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `pi-dash failed to start: ${(error as Error).message}\n`,
  );
  process.exitCode = 1;
});
