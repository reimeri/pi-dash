import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createAuthService, SESSION_COOKIE } from "../src/auth.js";
import { loggerOptions, sanitizeRequestUrl } from "../src/logger.js";
import { createOriginPolicy } from "../src/security.js";

const policy = createOriginPolicy({
  host: "127.0.0.1",
  port: 4317,
  uiOrigin: undefined,
});

describe("origin policy", () => {
  it("canonicalizes both IPv6 loopback spellings", () => {
    for (const host of ["::1", "0:0:0:0:0:0:0:1"]) {
      const ipv6Policy = createOriginPolicy({
        host,
        port: 4317,
        uiOrigin: undefined,
      });
      expect(ipv6Policy.serverOrigin).toBe("http://[::1]:4317");
      expect(ipv6Policy.validateHost({ host: "[::1]:4317" })).toBe(true);
      expect(
        ipv6Policy.validateOrigin({ origin: "http://[::1]:4317" }, true),
      ).toBe(true);
    }
  });
});

describe("local authentication", () => {
  it("consumes a bootstrap token once and expires sessions", () => {
    let now = 1_000;
    let sequence = 0;
    const auth = createAuthService({
      policy,
      now: () => now,
      randomToken: () => `token-${String(sequence++).padStart(40, "x")}`,
    });
    expect(auth.exchangeBootstrap("wrong")).toBeUndefined();
    const session = auth.exchangeBootstrap(auth.bootstrapToken);
    expect(session).toBeDefined();
    expect(auth.exchangeBootstrap(auth.bootstrapToken)).toBeUndefined();
    expect(auth.getSession(session?.id)).toEqual(session);
    now += 13 * 60 * 60 * 1000;
    expect(auth.getSession(session?.id)).toBeUndefined();
  });

  it("shares Host, Origin, and cookie checks with future upgrades", () => {
    const auth = createAuthService({ policy });
    const session = auth.exchangeBootstrap(auth.bootstrapToken)!;
    expect(
      auth.authenticateUpgrade({
        headers: {
          host: "127.0.0.1:4317",
          origin: "http://127.0.0.1:4317",
          cookie: `${SESSION_COOKIE}=${session.id}`,
        },
      }),
    ).toEqual(session);
    expect(
      auth.authenticateUpgrade({
        headers: {
          host: "attacker.invalid",
          origin: "http://attacker.invalid",
          cookie: `${SESSION_COOKIE}=${session.id}`,
        },
      }),
    ).toBeUndefined();
  });
});

describe("redaction", () => {
  it("removes bootstrap tokens from request URLs", () => {
    expect(
      sanitizeRequestUrl("/auth/bootstrap?token=super-secret&next=/"),
    ).toBe("/auth/bootstrap?token=%5BRedacted%5D&next=%2F");
  });

  it("redacts secrets from actual structured log output", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(loggerOptions("info"), destination);
    logger.info({
      req: { method: "GET", url: "/auth/bootstrap?token=url-secret" },
      token: "top-secret",
      context: { csrfToken: "csrf-secret", cookie: "session-secret" },
      headers: { authorization: "bearer-secret" },
    });
    expect(output).toContain("[Redacted]");
    for (const secret of [
      "url-secret",
      "top-secret",
      "csrf-secret",
      "session-secret",
      "bearer-secret",
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
