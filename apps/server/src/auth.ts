import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OriginPolicy, RequestHeaders } from "./security.js";

export const SESSION_COOKIE = "pi_dash_session";
const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  id: string;
  csrfToken: string;
  expiresAt: number;
}

export interface UpgradeRequest {
  headers: RequestHeaders;
}

export interface AuthService {
  bootstrapToken: string;
  exchangeBootstrap(candidate: string): Session | undefined;
  getSession(id: string | undefined): Session | undefined;
  authenticateUpgrade(request: UpgradeRequest): Session | undefined;
  clear(): void;
}

function defaultToken(): string {
  return randomBytes(32).toString("base64url");
}

function equalSecret(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export function createAuthService(options: {
  policy: OriginPolicy;
  now?: () => number;
  randomToken?: () => string;
}): AuthService {
  const now = options.now ?? Date.now;
  const makeToken = options.randomToken ?? defaultToken;
  const bootstrapToken = makeToken();
  const bootstrapExpiresAt = now() + BOOTSTRAP_TTL_MS;
  const sessions = new Map<string, Session>();
  let bootstrapUsed = false;

  function getSession(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const session = sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= now()) {
      sessions.delete(id);
      return undefined;
    }
    return session;
  }

  return {
    bootstrapToken,
    exchangeBootstrap(candidate) {
      if (
        bootstrapUsed ||
        now() >= bootstrapExpiresAt ||
        !equalSecret(candidate, bootstrapToken)
      )
        return undefined;
      bootstrapUsed = true;
      const session: Session = {
        id: makeToken(),
        csrfToken: makeToken(),
        expiresAt: now() + SESSION_TTL_MS,
      };
      sessions.set(session.id, session);
      return session;
    },
    getSession,
    authenticateUpgrade(request) {
      if (
        !options.policy.validateHost(request.headers) ||
        !options.policy.validateOrigin(request.headers, true)
      ) {
        return undefined;
      }
      return getSession(cookieValue(request.headers.cookie, SESSION_COOKIE));
    },
    clear() {
      bootstrapUsed = true;
      sessions.clear();
    },
  };
}
