import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Daemon } from "../src/daemon.js";
import { listenAndLaunchDashboard } from "../src/startup.js";

function daemon(
  bootstrapUrl: string,
  events: string[],
  openBrowser = true,
): Daemon {
  return {
    app: {
      listen: vi.fn(async () => {
        events.push("listen");
        return "http://127.0.0.1:4317";
      }),
      log: pino({ level: "silent" }),
    },
    config: { host: "127.0.0.1", port: 4317, openBrowser },
    bootstrapUrl,
    markReady: vi.fn(() => events.push("ready")),
  } as unknown as Daemon;
}

describe("daemon startup launch", () => {
  it("listens and marks ready before printing and opening the bootstrap URL", async () => {
    const events: string[] = [];
    const bootstrapUrl =
      "http://127.0.0.1:4317/auth/bootstrap?token=first-token";

    await listenAndLaunchDashboard(daemon(bootstrapUrl, events), {
      write: (message) => events.push(`write:${message.trim()}`),
      openBrowser: async (url) => {
        events.push(`open:${url}`);
      },
    });

    expect(events).toEqual([
      "listen",
      "ready",
      `write:Open Pi Dash: ${bootstrapUrl}`,
      `open:${bootstrapUrl}`,
    ]);
  });

  it("opens each replacement bootstrap URL and honors browser suppression", async () => {
    const launched: string[] = [];
    const openBrowser = async (url: string) => {
      launched.push(url);
    };
    const write = vi.fn();

    await listenAndLaunchDashboard(
      daemon("http://127.0.0.1:4317/auth/bootstrap?token=first", []),
      { write, openBrowser },
    );
    await listenAndLaunchDashboard(
      daemon("http://127.0.0.1:4317/auth/bootstrap?token=replacement", []),
      { write, openBrowser },
    );
    await listenAndLaunchDashboard(
      daemon(
        "http://127.0.0.1:4317/auth/bootstrap?token=suppressed",
        [],
        false,
      ),
      { write, openBrowser },
    );

    expect(launched).toEqual([
      "http://127.0.0.1:4317/auth/bootstrap?token=first",
      "http://127.0.0.1:4317/auth/bootstrap?token=replacement",
    ]);
    expect(write).toHaveBeenCalledTimes(3);
  });
});
