import { createHmac, timingSafeEqual } from "node:crypto";

interface ConfirmationPayload {
  v: 1;
  worktreeId: string;
  recordUpdatedAt: string;
  inspectionHash: string;
  expiresAt: number;
}

export interface RemovalConfirmation {
  token: string;
  expiresAt: string;
}

export interface RemovalConfirmationSigner {
  sign(input: {
    worktreeId: string;
    recordUpdatedAt: string;
    inspectionHash: string;
  }): RemovalConfirmation;
  verify(
    token: string,
    expected: {
      worktreeId: string;
      recordUpdatedAt: string;
      inspectionHash: string;
    },
  ): boolean;
}

export function createRemovalConfirmationSigner(options: {
  key: Buffer;
  now?: () => Date;
  ttlMs?: number;
}): RemovalConfirmationSigner {
  if (options.key.byteLength < 32) throw new Error("Signing key is too short");
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const signature = (payload: string) =>
    createHmac("sha256", options.key).update(payload).digest();

  return {
    sign(input) {
      const expiresAt = now().getTime() + ttlMs;
      const payload = Buffer.from(
        JSON.stringify({ v: 1, ...input, expiresAt }),
      ).toString("base64url");
      return {
        token: `${payload}.${signature(payload).toString("base64url")}`,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
    verify(token, expected) {
      const separator = token.indexOf(".");
      if (separator < 1 || token.indexOf(".", separator + 1) !== -1)
        return false;
      const encoded = token.slice(0, separator);
      const supplied = Buffer.from(token.slice(separator + 1), "base64url");
      const actual = signature(encoded);
      if (
        supplied.byteLength !== actual.byteLength ||
        !timingSafeEqual(supplied, actual)
      ) {
        return false;
      }
      try {
        const payload = JSON.parse(
          Buffer.from(encoded, "base64url").toString("utf8"),
        ) as Partial<ConfirmationPayload>;
        return (
          payload.v === 1 &&
          payload.worktreeId === expected.worktreeId &&
          payload.recordUpdatedAt === expected.recordUpdatedAt &&
          payload.inspectionHash === expected.inspectionHash &&
          typeof payload.expiresAt === "number" &&
          Number.isSafeInteger(payload.expiresAt) &&
          payload.expiresAt > now().getTime()
        );
      } catch {
        return false;
      }
    },
  };
}
