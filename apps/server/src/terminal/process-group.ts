import { readdir, readFile } from "node:fs/promises";
import type { IPty } from "node-pty";

export interface ProcessIdentity {
  pid: number;
  processGroup: number;
  session: number;
  foregroundProcessGroup: number;
  startTime: string;
}

export type ProcessScope = "process-group" | "session";

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
    const session = Number(fields[3]);
    const foregroundProcessGroup = Number(fields[5]);
    const startTime = fields[19];
    if (
      !Number.isInteger(processGroup) ||
      !Number.isInteger(session) ||
      !Number.isInteger(foregroundProcessGroup) ||
      !startTime
    ) {
      return undefined;
    }
    return {
      pid,
      processGroup,
      session,
      foregroundProcessGroup,
      startTime,
    };
  } catch {
    return undefined;
  }
}

function inScope(
  identity: ProcessIdentity,
  leader: ProcessIdentity,
  scope: ProcessScope,
): boolean {
  return scope === "session"
    ? identity.session === leader.session
    : identity.processGroup === leader.processGroup;
}

async function scanScope(
  leader: ProcessIdentity,
  scope: ProcessScope,
): Promise<ProcessIdentity[]> {
  if (process.platform !== "linux") return [];
  let entries: string[];
  try {
    // /proc entries can disappear at any time. Names avoid the implicit lstat
    // calls made by withFileTypes, which race short-lived processes.
    entries = await readdir("/proc");
  } catch {
    return [];
  }
  const identities = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map((entry) => readProcessIdentity(Number(entry))),
  );
  return identities.filter(
    (identity): identity is ProcessIdentity =>
      identity !== undefined && inScope(identity, leader, scope),
  );
}

async function readChildPids(pid: number): Promise<number[]> {
  try {
    const tasks = await readdir(`/proc/${pid}/task`);
    const children = await Promise.all(
      tasks
        .filter((task) => /^\d+$/.test(task))
        .map(async (task) => {
          try {
            return await readFile(`/proc/${pid}/task/${task}/children`, "utf8");
          } catch {
            return "";
          }
        }),
    );
    return [
      ...new Set(
        children
          .flatMap((value) => value.trim().split(/\s+/))
          .filter((value) => /^\d+$/.test(value))
          .map(Number),
      ),
    ];
  } catch {
    return [];
  }
}

async function scanTrackedDescendants(
  leader: ProcessIdentity,
  tracked: Map<number, ProcessIdentity>,
  scope: ProcessScope,
): Promise<ProcessIdentity[]> {
  const roots = [leader.pid];
  for (const [pid, identity] of tracked) {
    if (pid === leader.pid) continue;
    if (await identityIsAlive(identity)) roots.push(pid);
    else tracked.delete(pid);
  }
  const found: ProcessIdentity[] = [];
  const visited = new Set<number>();
  let pending = roots;
  while (pending.length > 0) {
    const current = pending.filter((pid) => !visited.has(pid));
    pending = [];
    for (const pid of current) visited.add(pid);
    const childPids = [
      ...new Set((await Promise.all(current.map(readChildPids))).flat()),
    ].filter((pid) => !visited.has(pid));
    const identities = await Promise.all(childPids.map(readProcessIdentity));
    for (const identity of identities) {
      if (!identity || !inScope(identity, leader, scope)) continue;
      found.push(identity);
      pending.push(identity.pid);
    }
  }
  return found;
}

async function identityIsAlive(identity: ProcessIdentity): Promise<boolean> {
  const current = await readProcessIdentity(identity.pid);
  return (
    current?.startTime === identity.startTime &&
    current.processGroup === identity.processGroup &&
    current.session === identity.session
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

async function captureWithWitnesses(
  leader: ProcessIdentity,
  scope: ProcessScope,
  witnesses: readonly ProcessIdentity[],
  tracked: Map<number, ProcessIdentity>,
): Promise<boolean> {
  const hasLivingWitness = async () => {
    for (const witness of witnesses) {
      if (await identityIsAlive(witness)) return true;
    }
    return false;
  };
  if (!(await hasLivingWitness())) return false;
  const members = await scanScope(leader, scope);
  if (!(await hasLivingWitness())) return false;
  for (const identity of members) tracked.set(identity.pid, identity);
  return true;
}

export function captureOwnedProcessMembers(
  leader: ProcessIdentity,
  tracked: Map<number, ProcessIdentity>,
  scope: ProcessScope = "process-group",
): Promise<boolean> {
  return captureWithWitnesses(leader, scope, [leader], tracked);
}

export async function captureOwnedProcessDescendants(
  leader: ProcessIdentity,
  tracked: Map<number, ProcessIdentity>,
  scope: ProcessScope = "process-group",
): Promise<boolean> {
  if (!(await identityIsAlive(leader))) return false;
  const descendants = await scanTrackedDescendants(leader, tracked, scope);
  if (!(await identityIsAlive(leader))) return false;
  for (const identity of descendants) tracked.set(identity.pid, identity);
  return true;
}

export async function stopOwnedProcesses(options: {
  pty?: IPty;
  leader?: ProcessIdentity;
  tracked: Map<number, ProcessIdentity>;
  timeoutMs: number;
  scope?: ProcessScope;
}): Promise<boolean> {
  const { pty, leader, tracked, timeoutMs, scope = "process-group" } = options;
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

  const refreshAndSignal = async (
    signal: NodeJS.Signals,
  ): Promise<ProcessIdentity[]> => {
    const witnesses = [...tracked.values()];
    await captureWithWitnesses(leader, scope, witnesses, tracked);
    const living = await livingMembers();
    // Signal children before the session/group leader so it remains a witness
    // while all owned jobs are captured.
    for (const identity of living.filter(({ pid }) => pid !== leader.pid)) {
      await signalIdentity(identity, signal);
    }
    const currentLeader = living.find(({ pid }) => pid === leader.pid);
    if (currentLeader) await signalIdentity(currentLeader, signal);
    return living;
  };

  await refreshAndSignal("SIGTERM");
  const started = Date.now();
  const escalationAt = started + Math.max(100, Math.floor(timeoutMs / 2));
  const deadline = started + timeoutMs;
  while (Date.now() < escalationAt) {
    if ((await refreshAndSignal("SIGTERM")).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  while (Date.now() < deadline) {
    if ((await refreshAndSignal("SIGKILL")).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await refreshAndSignal("SIGKILL");
  return (await livingMembers()).length === 0;
}

// Preserve focused names for existing process-group tests and callers.
export const captureOwnedProcessGroupMembers = captureOwnedProcessMembers;
export const captureOwnedProcessGroupDescendants =
  captureOwnedProcessDescendants;
export const stopOwnedProcessGroup = stopOwnedProcesses;
