import type { AppConfig } from "./config.js";

export interface RequestHeaders {
  host?: string;
  origin?: string;
  [key: string]: string | string[] | undefined;
}

function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export interface OriginPolicy {
  serverOrigin: string;
  allowedOrigins: ReadonlySet<string>;
  validateHost(headers: RequestHeaders): boolean;
  validateOrigin(headers: RequestHeaders, requireOrigin?: boolean): boolean;
}

export function createOriginPolicy(
  config: Pick<AppConfig, "host" | "port" | "uiOrigin">,
): OriginPolicy {
  const serverOrigin = new URL(
    `http://${hostForUrl(config.host)}:${config.port}`,
  ).origin;
  const expectedHost = new URL(serverOrigin).host.toLowerCase();
  const allowedOrigins = new Set([
    serverOrigin,
    ...(config.uiOrigin ? [config.uiOrigin] : []),
  ]);
  return {
    serverOrigin,
    allowedOrigins,
    validateHost(headers) {
      const host = headers.host;
      return typeof host === "string" && host.toLowerCase() === expectedHost;
    },
    validateOrigin(headers, requireOrigin = false) {
      const origin = headers.origin;
      if (origin === undefined) return !requireOrigin;
      return typeof origin === "string" && allowedOrigins.has(origin);
    },
  };
}
