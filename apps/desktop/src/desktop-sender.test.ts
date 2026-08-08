import { describe, expect, it } from "vitest";
import { validateDesktopSenderIdentity } from "./desktop-sender.js";

const origin = "http://127.0.0.1:4317";

function trustedIdentity() {
  const sender = {};
  const mainFrame = { url: `${origin}/` };
  return {
    sender,
    senderFrame: mainFrame,
    expectedSender: sender,
    expectedMainFrame: mainFrame,
    expectedOrigin: origin,
    windowAvailable: true,
  };
}

describe("desktop sender validation", () => {
  it("accepts only the current trusted main frame", () => {
    expect(() =>
      validateDesktopSenderIdentity(trustedIdentity()),
    ).not.toThrow();
  });

  it("rejects another webContents", () => {
    expect(() =>
      validateDesktopSenderIdentity({
        ...trustedIdentity(),
        sender: {},
      }),
    ).toThrow(/unavailable to this sender/);
  });

  it("rejects a child frame", () => {
    expect(() =>
      validateDesktopSenderIdentity({
        ...trustedIdentity(),
        senderFrame: { url: `${origin}/embedded` },
      }),
    ).toThrow(/unavailable to this sender/);
  });

  it("rejects a stale or untrusted origin", () => {
    const identity = trustedIdentity();
    identity.senderFrame.url = "http://127.0.0.1:9999/";
    expect(() => validateDesktopSenderIdentity(identity)).toThrow(
      /unavailable to this sender/,
    );
  });

  it("rejects after the main window is unavailable", () => {
    expect(() =>
      validateDesktopSenderIdentity({
        ...trustedIdentity(),
        windowAvailable: false,
      }),
    ).toThrow(/unavailable to this sender/);
  });
});
