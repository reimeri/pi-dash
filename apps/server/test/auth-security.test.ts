import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  createAuthService,
  MAX_REMOTE_SESSIONS_PER_PRINCIPAL,
  REMOTE_SESSION_TTL_MS,
  SESSION_COOKIE,
  SESSION_EXPIRED_SOCKET_CODE,
} from "../src/auth.js";
import { loggerOptions, sanitizeRequestUrl } from "../src/logger.js";
import { createOriginPolicy } from "../src/security.js";

const policy = createOriginPolicy({
  host: "127.0.0.1",
  port: 4317,
  uiOrigin: undefined,
  remoteAccess: undefined,
});
const remotePolicy = createOriginPolicy({
  host: "127.0.0.1",
  port: 4317,
  uiOrigin: undefined,
  remoteAccess: {
    provider: "tailscale",
    origin: "https://pi-dash-host.example-tailnet.ts.net",
    allowedUsers: ["owner@example.com"],
  },
});

describe("origin policy", () => {
  it("canonicalizes both IPv6 loopback spellings", () => {
    for (const host of ["::1", "0:0:0:0:0:0:0:1"]) {
      const ipv6Policy = createOriginPolicy({
        host,
        port: 4317,
        uiOrigin: undefined,
        remoteAccess: undefined,
      });
      expect(ipv6Policy.serverOrigin).toBe("http://[::1]:4317");
      expect(
        ipv6Policy.classifyRequest({
          host: "[::1]:4317",
          origin: "http://[::1]:4317",
        }),
      ).toEqual({ channel: "local" });
    }
  });

  it("accepts only the probed Tailscale Serve authority and identity shape", () => {
    const remoteHeaders = {
      host: "pi-dash-host.example-tailnet.ts.net",
      origin: "https://pi-dash-host.example-tailnet.ts.net",
      "tailscale-user-login": "owner@example.com",
    };
    expect(remotePolicy.classifyRequest(remoteHeaders, true)).toEqual({
      channel: "tailscale",
      principal: "owner@example.com",
    });
    expect(
      remotePolicy.classifyRequest({
        ...remoteHeaders,
        "tailscale-user-login": "other@example.com",
      }),
    ).toBeUndefined();
    expect(
      remotePolicy.classifyRequest({
        ...remoteHeaders,
        "tailscale-user-login": ["owner@example.com", "other@example.com"],
      }),
    ).toBeUndefined();
    expect(
      remotePolicy.classifyRequest({
        ...remoteHeaders,
        origin: "http://127.0.0.1:4317",
      }),
    ).toBeUndefined();
    expect(
      remotePolicy.classifyRequest({
        host: "127.0.0.1:4317",
        origin: "http://127.0.0.1:4317",
        "tailscale-user-login": "owner@example.com",
      }),
    ).toBeUndefined();
  });
});

describe("local authentication", () => {
  it("consumes a bootstrap token once and keeps sessions for the process lifetime", () => {
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
    expect(auth.getSession(session?.id)).toEqual(session);
  });

  it("rotates unused bootstrap tokens with issueBootstrap", () => {
    let now = 1_000;
    let sequence = 0;
    const auth = createAuthService({
      policy,
      now: () => now,
      randomToken: () => `token-${String(sequence++).padStart(40, "x")}`,
    });
    const first = auth.bootstrapToken;
    const second = auth.issueBootstrap();
    expect(second).not.toBe(first);
    expect(auth.exchangeBootstrap(first)).toBeUndefined();
    const session = auth.exchangeBootstrap(second);
    expect(session).toBeDefined();
    expect(auth.exchangeBootstrap(second)).toBeUndefined();
    const third = auth.issueBootstrap();
    now += 6 * 60 * 1000;
    expect(auth.exchangeBootstrap(third)).toBeUndefined();
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

describe("Tailscale authentication", () => {
  it("binds remote sessions to the current exact Tailscale principal", () => {
    const auth = createAuthService({ policy: remotePolicy });
    const headers = {
      host: "pi-dash-host.example-tailnet.ts.net",
      origin: "https://pi-dash-host.example-tailnet.ts.net",
      "tailscale-user-login": "owner@example.com",
    };
    const session = auth.exchangeTailscale({ headers });
    expect(session).toMatchObject({
      channel: "tailscale",
      principal: "owner@example.com",
    });
    expect(
      auth.authenticateRequest({
        headers: {
          ...headers,
          cookie: `${SESSION_COOKIE}=${session!.id}`,
        },
      }),
    ).toEqual(session);
    expect(
      auth.authenticateRequest({
        headers: {
          ...headers,
          "tailscale-user-login": "other@example.com",
          cookie: `${SESSION_COOKIE}=${session!.id}`,
        },
      }),
    ).toBeUndefined();
  });

  it("bounds sessions per principal and closes the oldest socket", () => {
    const auth = createAuthService({ policy: remotePolicy });
    const headers = {
      host: "pi-dash-host.example-tailnet.ts.net",
      origin: "https://pi-dash-host.example-tailnet.ts.net",
      "tailscale-user-login": "owner@example.com",
    };
    const first = auth.exchangeTailscale({ headers })!;
    const closed: Array<[number, string]> = [];
    auth.registerSocket(first, {
      close: (code, reason) => closed.push([code, reason]),
    });
    for (let index = 0; index < MAX_REMOTE_SESSIONS_PER_PRINCIPAL; index += 1) {
      auth.exchangeTailscale({ headers });
    }
    expect(auth.getSession(first.id)).toBeUndefined();
    expect(closed).toEqual([[SESSION_EXPIRED_SOCKET_CODE, "Session replaced"]]);
  });

  it("expires remote sessions and their registered sockets", () => {
    vi.useFakeTimers();
    try {
      const auth = createAuthService({ policy: remotePolicy });
      const headers = {
        host: "pi-dash-host.example-tailnet.ts.net",
        origin: "https://pi-dash-host.example-tailnet.ts.net",
        "tailscale-user-login": "owner@example.com",
      };
      const session = auth.exchangeTailscale({ headers })!;
      const closed: Array<[number, string]> = [];
      auth.registerSocket(session, {
        close: (code, reason) => closed.push([code, reason]),
      });
      vi.advanceTimersByTime(REMOTE_SESSION_TTL_MS);
      expect(auth.getSession(session.id)).toBeUndefined();
      expect(closed).toEqual([
        [SESSION_EXPIRED_SOCKET_CODE, "Session expired"],
      ]);
    } finally {
      vi.useRealTimers();
    }
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
      context: {
        csrfToken: "csrf-secret",
        cookie: "session-secret",
        desktopControlToken: "desktop-secret",
      },
      headers: {
        authorization: "bearer-secret",
        "tailscale-user-login": "identity-secret",
        "tailscale-user-name": "name-secret",
        "tailscale-user-profile-pic": "picture-secret",
      },
    });
    expect(output).toContain("[Redacted]");
    for (const secret of [
      "url-secret",
      "top-secret",
      "csrf-secret",
      "session-secret",
      "desktop-secret",
      "bearer-secret",
      "identity-secret",
      "name-secret",
      "picture-secret",
    ]) {
      expect(output).not.toContain(secret);
    }
  });
});
