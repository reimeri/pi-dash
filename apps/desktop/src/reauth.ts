const REQUEST_TIMEOUT_MS = 3_000;
const RESUME_RETRY_WINDOW_MS = 15_000;
const RESUME_RETRY_INTERVAL_MS = 1_000;

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function isDesktopRebootstrapResponse(
  value: unknown,
): value is { bootstrapUrl: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    "bootstrapUrl" in value &&
    typeof value.bootstrapUrl === "string" &&
    value.bootstrapUrl.length >= 1 &&
    value.bootstrapUrl.length <= 2_048
  );
}

export function validateBootstrapUrl(rawUrl: string): {
  url: string;
  origin: string;
} {
  const url = new URL(rawUrl);
  const loopback =
    url.hostname === "::1" ||
    (url.hostname.startsWith("127.") &&
      url.hostname.split(".").every((part) => /^\d+$/.test(part)));
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.pathname !== "/auth/bootstrap" ||
    !url.searchParams.has("token")
  ) {
    throw new Error("The daemon returned an invalid desktop launch URL");
  }
  return { url: url.href, origin: url.origin };
}

export async function requestDesktopRebootstrap(options: {
  origin: string;
  controlToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${options.origin}/auth/desktop/rebootstrap`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.controlToken}`,
      },
      signal: timeoutSignal(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    },
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message
        : `Desktop rebootstrap failed (${response.status})`;
    throw new Error(message);
  }
  if (!isDesktopRebootstrapResponse(body)) {
    throw new Error("The daemon returned an invalid rebootstrap response");
  }
  return validateBootstrapUrl(body.bootstrapUrl).url;
}

export async function daemonHealthReady(options: {
  origin: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.origin}/api/v1/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: timeoutSignal(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForDaemonHealth(options: {
  origin: string;
  fetchImpl?: typeof fetch;
  retryWindowMs?: number;
  retryIntervalMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetrying?: () => void;
}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + (options.retryWindowMs ?? RESUME_RETRY_WINDOW_MS);
  let retrying = false;

  while (true) {
    const remaining = Math.max(1, deadline - now());
    if (
      await daemonHealthReady({
        origin: options.origin,
        fetchImpl: options.fetchImpl,
        timeoutMs: Math.min(REQUEST_TIMEOUT_MS, remaining),
      })
    ) {
      return true;
    }
    if (!retrying) {
      retrying = true;
      options.onRetrying?.();
    }
    const delayMs = Math.min(
      options.retryIntervalMs ?? RESUME_RETRY_INTERVAL_MS,
      deadline - now(),
    );
    if (delayMs <= 0) return false;
    await sleep(delayMs);
  }
}
