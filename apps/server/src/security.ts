import type { AppConfig } from "./config.js";

export interface RequestHeaders {
  host?: string;
  origin?: string;
  [key: string]: string | string[] | undefined;
}

function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export interface RequestAccess {
  channel: "local" | "tailscale";
  principal?: string;
}

export interface OriginPolicy {
  serverOrigin: string;
  remoteOrigin?: string;
  allowedOrigins: ReadonlySet<string>;
  classifyRequest(
    headers: RequestHeaders,
    requireOrigin?: boolean,
  ): RequestAccess | undefined;
}

function hasTailscaleIdentityHeaders(headers: RequestHeaders): boolean {
  return [
    "tailscale-user-login",
    "tailscale-user-name",
    "tailscale-user-profile-pic",
  ].some((name) => headers[name] !== undefined);
}

export function createOriginPolicy(
  config: Pick<AppConfig, "host" | "port" | "uiOrigin" | "remoteAccess">,
): OriginPolicy {
  const serverOrigin = new URL(
    `http://${hostForUrl(config.host)}:${config.port}`,
  ).origin;
  const localHost = new URL(serverOrigin).host.toLowerCase();
  const localOrigins = new Set([
    serverOrigin,
    ...(config.uiOrigin ? [config.uiOrigin] : []),
  ]);
  const remoteOrigin = config.remoteAccess?.origin;
  const remoteHost = remoteOrigin
    ? new URL(remoteOrigin).host.toLowerCase()
    : undefined;
  const allowedUsers = new Set(config.remoteAccess?.allowedUsers ?? []);
  const allowedOrigins = new Set([
    ...localOrigins,
    ...(remoteOrigin ? [remoteOrigin] : []),
  ]);

  return {
    serverOrigin,
    remoteOrigin,
    allowedOrigins,
    classifyRequest(headers, requireOrigin = false) {
      const host = headers.host;
      if (typeof host !== "string") return undefined;
      const normalizedHost = host.toLowerCase();
      const origin = headers.origin;
      if (origin !== undefined && typeof origin !== "string") return undefined;

      if (normalizedHost === localHost) {
        if (hasTailscaleIdentityHeaders(headers)) return undefined;
        if (origin === undefined) {
          return requireOrigin ? undefined : { channel: "local" };
        }
        return localOrigins.has(origin) ? { channel: "local" } : undefined;
      }

      if (!remoteOrigin || normalizedHost !== remoteHost) return undefined;
      const login = headers["tailscale-user-login"];
      if (typeof login !== "string" || !allowedUsers.has(login)) {
        return undefined;
      }
      if (origin === undefined) {
        return requireOrigin
          ? undefined
          : { channel: "tailscale", principal: login };
      }
      if (origin !== remoteOrigin) return undefined;
      return { channel: "tailscale", principal: login };
    },
  };
}
