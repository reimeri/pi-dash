import pino, { type Logger, type LoggerOptions } from "pino";
import type { LogLevel } from "./config.js";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "cookie",
  "token",
  "bootstrapToken",
  "sessionId",
  "csrfToken",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.bootstrapToken",
  "*.sessionId",
  "*.csrfToken",
  "*.*.authorization",
  "*.*.cookie",
  "*.*.token",
  "*.*.bootstrapToken",
  "*.*.sessionId",
  "*.*.csrfToken",
];

export function sanitizeRequestUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "http://loopback.invalid");
    if (url.searchParams.has("token"))
      url.searchParams.set("token", "[Redacted]");
    return `${url.pathname}${url.search}`;
  } catch {
    return rawUrl.replace(/([?&]token=)[^&]*/gi, "$1[Redacted]");
  }
}

export function loggerOptions(level: LogLevel): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
    serializers: {
      req(request: { method?: string; url?: string; id?: string }) {
        return {
          method: request.method,
          url: request.url ? sanitizeRequestUrl(request.url) : undefined,
          requestId: request.id,
        };
      },
    },
  };
}

export function createLogger(level: LogLevel): Logger {
  return pino(loggerOptions(level));
}
