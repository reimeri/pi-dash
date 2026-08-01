import type { Logger } from "pino";
import { openDashboardBrowser } from "./browser.js";
import type { Daemon } from "./daemon.js";

export interface StartupOptions {
  write?: (message: string) => void;
  openBrowser?: (url: string, logger: Logger) => Promise<void>;
}

export async function listenAndLaunchDashboard(
  daemon: Daemon,
  options: StartupOptions = {},
): Promise<void> {
  await daemon.app.listen({
    host: daemon.config.host,
    port: daemon.config.port,
  });
  daemon.markReady();

  const message = `Open Pi Dash: ${daemon.bootstrapUrl}\n`;
  if (options.write) options.write(message);
  else process.stdout.write(message);

  if (daemon.config.openBrowser) {
    await (options.openBrowser ?? openDashboardBrowser)(
      daemon.bootstrapUrl,
      daemon.app.log,
    );
  }
}
