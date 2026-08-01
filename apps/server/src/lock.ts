import {
  chmodSync,
  closeSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { flockSync } from "fs-ext";

export interface DaemonLock {
  release(): void;
}

export function acquireDaemonLock(path: string): DaemonLock {
  const descriptor = openSync(path, "a+", 0o600);
  chmodSync(path, 0o600);
  try {
    flockSync(descriptor, "exnb");
  } catch (error) {
    closeSync(descriptor);
    let owner = "unknown owner";
    try {
      const metadata = JSON.parse(readFileSync(path, "utf8")) as {
        pid?: unknown;
      };
      if (typeof metadata.pid === "number") owner = `PID ${metadata.pid}`;
    } catch {
      // Metadata is diagnostic only; the kernel lock is authoritative.
    }
    throw new Error(
      `Another pi-dash daemon owns this data directory (${owner})`,
      { cause: error },
    );
  }

  ftruncateSync(descriptor, 0);
  writeSync(
    descriptor,
    `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
    0,
    "utf8",
  );
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        flockSync(descriptor, "un");
      } finally {
        closeSync(descriptor);
      }
    },
  };
}
