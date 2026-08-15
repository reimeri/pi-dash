import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  OriginPolicy,
  RequestAccess,
  RequestHeaders,
} from "./security.js";

export const SESSION_COOKIE = "pi_dash_session";
export const REMOTE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_EXPIRED_SOCKET_CODE = 4001;
export const MAX_REMOTE_SESSIONS_PER_PRINCIPAL = 8;
export const MAX_REMOTE_SESSIONS = 64;
const BOOTSTRAP_TTL_MS = 5 * 60 * 1000;

export interface Session {
  id: string;
  csrfToken: string;
  channel: "local" | "tailscale";
  createdAt: number;
  principal?: string;
  expiresAt?: number;
}

export interface AuthRequest {
  headers: RequestHeaders;
}

export interface AuthService {
  readonly bootstrapToken: string;
  issueBootstrap(): string;
  exchangeBootstrap(candidate: string): Session | undefined;
  exchangeTailscale(request: AuthRequest): Session | undefined;
  getSession(id: string | undefined): Session | undefined;
  authenticateRequest(
    request: AuthRequest,
    requireOrigin?: boolean,
  ): Session | undefined;
  authenticateUpgrade(request: AuthRequest): Session | undefined;
  registerSocket(
    session: Session,
    socket: { close(code: number, reason: string): void },
  ): () => void;
  clear(): void;
}

type SocketCloser = (code: number, reason: string) => void;

function defaultToken(): string {
  return randomBytes(32).toString("base64url");
}

export function equalSecret(candidate: string, expected: string): boolean {
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

function sessionMatchesAccess(
  session: Session,
  access: RequestAccess,
): boolean {
  if (session.channel !== access.channel) return false;
  return session.channel === "local" || session.principal === access.principal;
}

export function createAuthService(options: {
  policy: OriginPolicy;
  now?: () => number;
  randomToken?: () => string;
}): AuthService {
  const now = options.now ?? Date.now;
  const makeToken = options.randomToken ?? defaultToken;
  let bootstrapToken = makeToken();
  let bootstrapExpiresAt = now() + BOOTSTRAP_TTL_MS;
  const sessions = new Map<string, Session>();
  const sessionExpiryTimers = new Map<string, NodeJS.Timeout>();
  const socketClosers = new Map<string, Set<SocketCloser>>();
  let bootstrapUsed = false;

  function revokeSession(
    id: string,
    code = SESSION_EXPIRED_SOCKET_CODE,
    reason = "Session expired",
  ): void {
    sessions.delete(id);
    const timer = sessionExpiryTimers.get(id);
    if (timer) clearTimeout(timer);
    sessionExpiryTimers.delete(id);
    const closers = [...(socketClosers.get(id) ?? [])];
    for (const close of closers) close(code, reason);
    socketClosers.delete(id);
  }

  function sweepExpiredSessions(): void {
    const current = now();
    for (const session of sessions.values()) {
      if (session.expiresAt !== undefined && current >= session.expiresAt) {
        revokeSession(session.id);
      }
    }
  }

  function remoteSessions(): Session[] {
    return [...sessions.values()]
      .filter((session) => session.channel === "tailscale")
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  function enforceRemoteSessionBounds(principal: string): void {
    const principalSessions = remoteSessions().filter(
      (session) => session.principal === principal,
    );
    while (principalSessions.length > MAX_REMOTE_SESSIONS_PER_PRINCIPAL) {
      const oldest = principalSessions.shift()!;
      revokeSession(oldest.id, SESSION_EXPIRED_SOCKET_CODE, "Session replaced");
    }
    const allRemoteSessions = remoteSessions();
    while (allRemoteSessions.length > MAX_REMOTE_SESSIONS) {
      const oldest = allRemoteSessions.shift()!;
      revokeSession(oldest.id, SESSION_EXPIRED_SOCKET_CODE, "Session replaced");
    }
  }

  function getSession(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const session = sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt !== undefined && now() >= session.expiresAt) {
      revokeSession(id);
      return undefined;
    }
    return session;
  }

  function createSession(
    channel: Session["channel"],
    principal?: string,
  ): Session {
    sweepExpiredSessions();
    const createdAt = now();
    const session: Session = {
      id: makeToken(),
      csrfToken: makeToken(),
      channel,
      createdAt,
      ...(principal ? { principal } : {}),
      ...(channel === "tailscale"
        ? { expiresAt: createdAt + REMOTE_SESSION_TTL_MS }
        : {}),
    };
    sessions.set(session.id, session);
    if (session.expiresAt !== undefined) {
      const timer = setTimeout(
        () => revokeSession(session.id),
        Math.max(0, session.expiresAt - now()),
      );
      timer.unref?.();
      sessionExpiryTimers.set(session.id, timer);
      enforceRemoteSessionBounds(principal!);
    }
    return session;
  }

  function accessFor(
    request: AuthRequest,
    requireOrigin: boolean,
  ): RequestAccess | undefined {
    return options.policy.classifyRequest(request.headers, requireOrigin);
  }

  function authenticateRequest(
    request: AuthRequest,
    requireOrigin = false,
  ): Session | undefined {
    const access = accessFor(request, requireOrigin);
    if (!access) return undefined;
    const session = getSession(
      cookieValue(request.headers.cookie, SESSION_COOKIE),
    );
    return session && sessionMatchesAccess(session, access)
      ? session
      : undefined;
  }

  return {
    get bootstrapToken() {
      return bootstrapToken;
    },
    issueBootstrap() {
      bootstrapToken = makeToken();
      bootstrapExpiresAt = now() + BOOTSTRAP_TTL_MS;
      bootstrapUsed = false;
      return bootstrapToken;
    },
    exchangeBootstrap(candidate) {
      if (
        bootstrapUsed ||
        now() >= bootstrapExpiresAt ||
        !equalSecret(candidate, bootstrapToken)
      ) {
        return undefined;
      }
      bootstrapUsed = true;
      return createSession("local");
    },
    exchangeTailscale(request) {
      const access = accessFor(request, true);
      if (access?.channel !== "tailscale" || !access.principal) {
        return undefined;
      }
      const existing = authenticateRequest(request, true);
      if (existing?.channel === "tailscale") return existing;
      return createSession("tailscale", access.principal);
    },
    getSession,
    authenticateRequest,
    authenticateUpgrade(request) {
      return authenticateRequest(request, true);
    },
    registerSocket(session, socket) {
      let active = true;
      const unregister = () => {
        if (!active) return;
        active = false;
        const sessionClosers = socketClosers.get(session.id);
        sessionClosers?.delete(close);
        if (sessionClosers?.size === 0) socketClosers.delete(session.id);
      };
      const close: SocketCloser = (code, reason) => {
        if (!active) return;
        unregister();
        socket.close(code, reason);
      };
      const sessionClosers = socketClosers.get(session.id) ?? new Set();
      sessionClosers.add(close);
      socketClosers.set(session.id, sessionClosers);
      return unregister;
    },
    clear() {
      bootstrapUsed = true;
      for (const timer of sessionExpiryTimers.values()) clearTimeout(timer);
      sessionExpiryTimers.clear();
      for (const closers of [...socketClosers.values()]) {
        for (const close of [...closers]) close(1012, "Daemon shutting down");
      }
      socketClosers.clear();
      sessions.clear();
    },
  };
}
