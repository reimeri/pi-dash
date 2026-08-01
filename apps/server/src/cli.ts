import { createDaemon } from "./daemon.js";

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
    await daemon.app.listen({
      host: daemon.config.host,
      port: daemon.config.port,
    });
    daemon.markReady();
    process.stdout.write(`Open Pi Dash: ${daemon.bootstrapUrl}\n`);
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
