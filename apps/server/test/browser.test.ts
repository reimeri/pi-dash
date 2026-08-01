import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { openDashboardBrowser } from "../src/browser.js";

describe("dashboard browser launch", () => {
  it("opens the bootstrap URL", async () => {
    const opener = vi.fn(async () => undefined);
    const url = "http://127.0.0.1:4317/auth/bootstrap?token=secret";

    await openDashboardBrowser(url, pino({ level: "silent" }), opener);

    expect(opener).toHaveBeenCalledOnce();
    expect(opener).toHaveBeenCalledWith(url);
  });

  it("reports launch failures without exposing the bootstrap URL", async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as pino.Logger;
    const secret = "secret-bootstrap-token";
    const opener = vi.fn(async () => {
      const error = new Error(`Unable to open URL containing ${secret}`);
      error.name = `BrowserLaunchError:${secret}`;
      throw error;
    });

    await expect(
      openDashboardBrowser(
        `http://127.0.0.1:4317/auth/bootstrap?token=${secret}`,
        logger,
        opener,
      ),
    ).resolves.toBeUndefined();

    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(warn).toHaveBeenCalledWith(
      "Unable to open Pi Dash in the default browser; use the printed URL instead",
    );
  });
});
