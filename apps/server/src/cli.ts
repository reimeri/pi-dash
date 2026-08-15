import { createDaemon } from "./daemon.js";
import {
  desktopOwnerFileDescriptor,
  watchDesktopOwner,
} from "./desktop-owner.js";
import { listenAndLaunchDashboard } from "./startup.js";

process.on("uncaughtExceptionMonitor", (error, origin) => {
  const detail = error.stack ?? `${error.name}: ${error.message}`;
  process.stderr.write(`pi-dash fatal ${origin}: ${detail}\n`);
});

async function main(): Promise<void> {
  const desktopOwner = desktopOwnerFileDescriptor();
  const daemon = await createDaemon();
  let stopping: Promise<void> | undefined;
  let stopWatchingDesktopOwner: (() => void) | undefined;
  const stop = (
    reason: NodeJS.Signals | "desktop-owner-closed",
  ): Promise<void> => {
    if (!stopping) {
      stopWatchingDesktopOwner?.();
      stopWatchingDesktopOwner = undefined;
      daemon.app.log.info({ reason }, "Shutting down");
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
  process.on("SIGUSR1", () => {
    if (stopping) return;
    try {
      const bootstrapUrl = daemon.renewBootstrap();
      process.stdout.write(`Open Pi Dash: ${bootstrapUrl}\n`);
      daemon.app.log.info("Issued a fresh launch link");
    } catch (error) {
      process.stderr.write(
        `pi-dash failed to issue a launch link: ${(error as Error).message}\n`,
      );
    }
  });

  if (desktopOwner !== undefined) {
    stopWatchingDesktopOwner = watchDesktopOwner(desktopOwner, () => {
      void stop("desktop-owner-closed").catch((error: unknown) => {
        process.stderr.write(
          `pi-dash owner-loss shutdown failed: ${(error as Error).message}\n`,
        );
        process.exitCode = 1;
      });
    });
  }

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
