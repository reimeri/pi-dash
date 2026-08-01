import { readdir, readFile } from "node:fs/promises";
import type { IPty } from "node-pty";

export interface ProcessIdentity {
  pid: number;
  processGroup: number;
  startTime: string;
}

export async function readProcessIdentity(
  pid: number,
): Promise<ProcessIdentity | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isInteger(processGroup) || !startTime) return undefined;
    return { pid, processGroup, startTime };
  } catch {
    return undefined;
  }
}

async function scanProcessGroup(
  processGroup: number,
): Promise<ProcessIdentity[]> {
  if (process.platform !== "linux") return [];
  const entries = await readdir("/proc", { withFileTypes: true });
  const identities = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => readProcessIdentity(Number(entry.name))),
  );
  return identities.filter(
    (identity): identity is ProcessIdentity =>
      identity !== undefined && identity.processGroup === processGroup,
  );
}

async function identityIsAlive(identity: ProcessIdentity): Promise<boolean> {
  const current = await readProcessIdentity(identity.pid);
  return (
    current?.startTime === identity.startTime &&
    current.processGroup === identity.processGroup
  );
}

async function signalIdentity(
  identity: ProcessIdentity,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!(await identityIsAlive(identity))) return;
  try {
    process.kill(identity.pid, signal);
  } catch {
    // The exact process may exit between validation and signaling.
  }
}

export async function captureOwnedProcessGroupMembers(
  leader: ProcessIdentity,
  tracked: Map<number, ProcessIdentity>,
): Promise<boolean> {
  if (!(await identityIsAlive(leader))) return false;
  const members = await scanProcessGroup(leader.processGroup);
  if (!(await identityIsAlive(leader))) return false;
  for (const identity of members) tracked.set(identity.pid, identity);
  return true;
}

export async function stopOwnedProcessGroup(options: {
  pty?: IPty;
  leader?: ProcessIdentity;
  tracked: Map<number, ProcessIdentity>;
  timeoutMs: number;
  leaderIsLive: () => boolean;
}): Promise<boolean> {
  const { pty, leader, tracked, timeoutMs, leaderIsLive } = options;
  if (process.platform !== "linux" || !leader) {
    if (!pty) return true;
    try {
      pty.kill("SIGTERM");
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    try {
      pty.kill("SIGKILL");
    } catch {
      // The PTY already exited.
    }
    return true;
  }

  const livingMembers = async (): Promise<ProcessIdentity[]> => {
    const living: ProcessIdentity[] = [];
    for (const [pid, identity] of tracked) {
      if (await identityIsAlive(identity)) living.push(identity);
      else tracked.delete(pid);
    }
    return living;
  };

  const captured = leaderIsLive()
    ? await captureOwnedProcessGroupMembers(leader, tracked)
    : false;
  if (captured && leaderIsLive()) {
    try {
      process.kill(-leader.processGroup, "SIGTERM");
    } catch {
      // Captured identities below remain safe to signal individually.
    }
  } else {
    for (const identity of await livingMembers())
      await signalIdentity(identity, "SIGTERM");
  }

  const started = Date.now();
  const escalationAt = started + Math.max(100, Math.floor(timeoutMs / 2));
  const deadline = started + timeoutMs;
  while (Date.now() < escalationAt) {
    if (leaderIsLive()) await captureOwnedProcessGroupMembers(leader, tracked);
    if ((await livingMembers()).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const identity of await livingMembers())
    await signalIdentity(identity, "SIGKILL");
  while (Date.now() < deadline) {
    if ((await livingMembers()).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return (await livingMembers()).length === 0;
}
