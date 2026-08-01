import { createHmac, timingSafeEqual } from "node:crypto";

interface SnapshotPayload {
  v: 1;
  workspaceId: string;
  ref: string;
  commit: string;
  expiresAt: number;
}

export interface BaseSnapshot {
  token: string;
  expiresAt: string;
}

export interface BaseSnapshotSigner {
  sign(workspaceId: string, ref: string, commit: string): BaseSnapshot;
  verify(
    token: string,
    expected: { workspaceId: string; ref: string; commit: string },
  ): boolean;
}

export function createBaseSnapshotSigner(options: {
  key: Buffer;
  now?: () => Date;
  ttlMs?: number;
}): BaseSnapshotSigner {
  if (options.key.byteLength < 32) throw new Error("Snapshot key is too short");
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  const signature = (payload: string) =>
    createHmac("sha256", options.key).update(payload).digest();

  return {
    sign(workspaceId, ref, commit) {
      const expiresAt = now().getTime() + ttlMs;
      const payload = Buffer.from(
        JSON.stringify({ v: 1, workspaceId, ref, commit, expiresAt }),
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
        ) as Partial<SnapshotPayload>;
        return (
          payload.v === 1 &&
          payload.workspaceId === expected.workspaceId &&
          payload.ref === expected.ref &&
          payload.commit === expected.commit &&
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
