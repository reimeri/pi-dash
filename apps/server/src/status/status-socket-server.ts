import { chmodSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  STATUS_MAX_FRAME_BYTES,
  StatusExtensionFrameSchema,
  type StatusExtensionFrame,
} from "@pi-dash/contracts";
import { Value } from "@sinclair/typebox/value";
import type { Logger } from "pino";
import type { StatusService } from "./status-service.js";

const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1_000;

export interface StatusSocketServer {
  readonly path: string;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createStatusSocketServer(options: {
  path: string;
  statuses: StatusService;
  logger?: Logger;
  now?: () => Date;
  maxFrameBytes?: number;
  maxConnections?: number;
  handshakeTimeoutMs?: number;
}): StatusSocketServer {
  const now = options.now ?? (() => new Date());
  const maxFrameBytes = options.maxFrameBytes ?? STATUS_MAX_FRAME_BYTES;
  const maxConnections = options.maxConnections ?? 64;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  const sockets = new Set<Socket>();
  const connections = new Map<string, Set<Socket>>();
  let server: Server | undefined;
  let startPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  function connectionKey(frame: StatusExtensionFrame): string {
    return `${frame.runtimeId}:${frame.extensionInstanceId}`;
  }

  function track(
    socket: Socket,
    keys: Set<string>,
    frame: StatusExtensionFrame,
  ) {
    const key = connectionKey(frame);
    keys.add(key);
    const peers = connections.get(key) ?? new Set<Socket>();
    peers.add(socket);
    connections.set(key, peers);
  }

  function validTimestamp(timestamp: string): boolean {
    const parsed = Date.parse(timestamp);
    return (
      Number.isFinite(parsed) &&
      Math.abs(now().getTime() - parsed) <= MAX_CLOCK_SKEW_MS
    );
  }

  function processLine(
    socket: Socket,
    keys: Set<string>,
    line: Buffer,
  ): boolean {
    if (line.length === 0) return false;
    if (line.length > maxFrameBytes) {
      socket.destroy();
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      socket.destroy();
      return false;
    }
    if (!Value.Check(StatusExtensionFrameSchema, parsed)) {
      socket.destroy();
      return false;
    }
    const frame = parsed as StatusExtensionFrame;
    if (!validTimestamp(frame.timestamp)) {
      socket.destroy();
      return false;
    }
    try {
      options.statuses.process(frame);
      track(socket, keys, frame);
      return true;
    } catch (error) {
      options.logger?.debug(
        {
          code:
            error instanceof Error && "code" in error
              ? String(error.code)
              : "STATUS_EVENT_INVALID",
          runtimeId: frame.runtimeId,
        },
        "Rejected status side-channel frame",
      );
      socket.destroy();
      return false;
    }
  }

  function accept(socket: Socket): void {
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);
    const keys = new Set<string>();
    let authenticated = false;
    const handshakeDeadline = setTimeout(() => {
      if (!authenticated) socket.destroy();
    }, handshakeTimeoutMs);
    handshakeDeadline.unref?.();
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > maxFrameBytes && !pending.includes(0x0a)) {
        socket.destroy();
        return;
      }
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        if (processLine(socket, keys, line) && !authenticated) {
          authenticated = true;
          clearTimeout(handshakeDeadline);
        }
        if (socket.destroyed) return;
        newline = pending.indexOf(0x0a);
      }
    });
    socket.on("error", () => {
      // Malformed clients and daemon shutdown are intentionally silent.
    });
    socket.once("close", () => {
      clearTimeout(handshakeDeadline);
      sockets.delete(socket);
      for (const key of keys) {
        const peers = connections.get(key);
        peers?.delete(socket);
        if (peers && peers.size > 0) continue;
        connections.delete(key);
        const separator = key.indexOf(":");
        options.statuses.disconnect(
          key.slice(0, separator),
          key.slice(separator + 1),
        );
      }
    });
  }

  return {
    path: options.path,
    start() {
      startPromise ??= new Promise<void>((resolve, reject) => {
        const parent = statSync(dirname(options.path));
        if (
          !parent.isDirectory() ||
          (parent.mode & 0o777) !== 0o700 ||
          (process.getuid && parent.uid !== process.getuid())
        ) {
          reject(
            new Error(
              "Status socket parent must be a private user-owned directory",
            ),
          );
          return;
        }
        rmSync(options.path, { force: true });
        server = createServer(accept);
        server.once("error", reject);
        server.listen(options.path, () => {
          server?.off("error", reject);
          chmodSync(options.path, 0o600);
          resolve();
        });
      });
      return startPromise;
    },
    close() {
      closePromise ??= (async () => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        connections.clear();
        if (server?.listening) {
          await new Promise<void>((resolve) => server!.close(() => resolve()));
        }
        server = undefined;
        rmSync(options.path, { force: true });
      })();
      return closePromise;
    },
  };
}
