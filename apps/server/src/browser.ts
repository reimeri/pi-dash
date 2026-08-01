import open from "open";
import type { Logger } from "pino";

export type BrowserOpener = (url: string) => Promise<unknown>;

export async function openDashboardBrowser(
  url: string,
  logger: Logger,
  opener: BrowserOpener = open,
): Promise<void> {
  try {
    await opener(url);
  } catch {
    logger.warn(
      "Unable to open Pi Dash in the default browser; use the printed URL instead",
    );
  }
}
