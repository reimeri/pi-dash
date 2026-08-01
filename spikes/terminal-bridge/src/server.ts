import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { access, chmod, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createServer as createUnixServer, type Server as UnixServer, type Socket as UnixSocket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { WebSocket } from "ws";
import {
  MAX_CLIENT_FRAME_BYTES,
  PROTOCOL_VERSION,
  STATUS_EVENTS,
  type ServerFrame,
  type StatusEventFrame,
  parseClientFrame,
} from "./protocol.js";
import { OutputRing } from "./output-ring.js";
import { initialStatus, reduceStatus, type StatusSnapshot } from "./status-reducer.js";

const execFileAsync = promisify(execFile);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const lockfile = require("../package-lock.json") as {
  packages: Record<string, { version?: string }>;
};
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const DEFAULT_BUFFER_BYTES = 1024 * 1024;
const STATUS_FRAME_BYTES = 16 * 1024;
const MAX_WEBSOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

interface RuntimeInfo {
  state: "running" | "exited";
  exitCode: number | null;
}

export interface SpikeServerOptions {
  cwd: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  fixture?: boolean;
  piPath?: string;
  outputBufferBytes?: number;
  serveClient?: boolean;
  shutdownGraceMs?: number;
  disableStatusFixture?: boolean;
}

export interface SpikeServer {
  app: FastifyInstance;
  address: string;
  runtimeId: string;
  runtimePid: number;
  statusSocketPath: string;
  close(): Promise<void>;
}

interface ClientConnection {
  socket: WebSocket;
  replayReady: boolean;
}

interface Diagnostics {
  websocketConnections: number;
  statusConnections: number;
  statusEventsAccepted: number;
  statusEventsRejected: number;
  malformedClientFrames: number;
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(socket: WebSocket, frame: ServerFrame): boolean {
  if (socket.readyState !== 1) return false;
  if (socket.bufferedAmount > MAX_WEBSOCKET_BUFFERED_BYTES) {
    socket.close(1013, "Client is not draining terminal output");
    return false;
  }
  socket.send(JSON.stringify(frame));
  return true;
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function resolveExecutable(candidate: string): Promise<string> {
  const paths = candidate.includes("/")
    ? [isAbsolute(candidate) ? candidate : resolve(candidate)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, candidate));
  for (const path of paths) {
    try {
      const canonical = await realpath(path);
      await access(canonical, fsConstants.X_OK);
      return canonical;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Executable '${candidate}' was not found or is not executable.`);
}

async function validateGitTopLevel(selectedPath: string): Promise<string> {
  const canonical = await realpath(selectedPath);
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: canonical,
    encoding: "utf8",
    timeout: 10_000,
  });
  const topLevel = await realpath(stdout.trim());
  if (canonical !== topLevel) throw new Error(`Selected cwd must be the Git top level: ${topLevel}`);
  return canonical;
}

function parseStatusFrame(line: string, runtimeId: string, token: string): StatusEventFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  if (
    frame.v !== PROTOCOL_VERSION ||
    frame.runtimeId !== runtimeId ||
    typeof frame.token !== "string" ||
    !safeEqual(frame.token, token) ||
    !STATUS_EVENTS.includes(frame.event as StatusEventFrame["event"])
  ) {
    return null;
  }
  if (frame.interactionId !== undefined && typeof frame.interactionId !== "string") return null;
  if (frame.reason !== undefined && typeof frame.reason !== "string") return null;
  return frame as unknown as StatusEventFrame;
}

async function closeUnixServer(server: UnixServer, sockets: Set<UnixSocket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

interface ProcessIdentity {
  pid: number;
  processGroup: number;
  startTime: string;
}

async function readProcessIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isInteger(processGroup) || !startTime) return undefined;
    return { pid, processGroup, startTime };
  } catch {
    return undefined;
  }
}

async function scanProcessGroup(processGroup: number): Promise<ProcessIdentity[]> {
  if (process.platform !== "linux") return [];
  const entries = await readdir("/proc", { withFileTypes: true });
  const identities = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => readProcessIdentity(Number(entry.name))),
  );
  return identities.filter(
    (identity): identity is ProcessIdentity => identity !== undefined && identity.processGroup === processGroup,
  );
}

async function identityIsAlive(identity: ProcessIdentity): Promise<boolean> {
  const current = await readProcessIdentity(identity.pid);
  return current?.startTime === identity.startTime && current.processGroup === identity.processGroup;
}

async function signalIdentity(identity: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  if (!(await identityIsAlive(identity))) return;
  try {
    process.kill(identity.pid, signal);
  } catch {
    // The exact process may exit between identity validation and signaling.
  }
}

async function captureOwnedProcessGroupMembers(
  leaderIdentity: ProcessIdentity,
  trackedMembers: Map<number, ProcessIdentity>,
): Promise<boolean> {
  if (!(await identityIsAlive(leaderIdentity))) return false;
  const members = await scanProcessGroup(leaderIdentity.processGroup);
  if (!(await identityIsAlive(leaderIdentity))) return false;
  for (const identity of members) trackedMembers.set(identity.pid, identity);
  return true;
}

async function waitForExit(
  ptyProcess: IPty,
  timeoutMs: number,
  leaderIdentity: ProcessIdentity | undefined,
  trackedMembers: Map<number, ProcessIdentity>,
): Promise<void> {
  if (process.platform !== "linux" || !leaderIdentity) {
    await new Promise<void>((resolveExit) => {
      const disposable = ptyProcess.onExit(() => {
        clearTimeout(deadline);
        disposable.dispose();
        resolveExit();
      });
      const deadline = setTimeout(resolveExit, timeoutMs);
      try {
        ptyProcess.kill("SIGTERM");
      } catch {
        clearTimeout(deadline);
        disposable.dispose();
        resolveExit();
      }
    });
    return;
  }

  const livingMembers = async (): Promise<ProcessIdentity[]> => {
    const living: ProcessIdentity[] = [];
    for (const [pid, identity] of trackedMembers) {
      if (await identityIsAlive(identity)) living.push(identity);
      else trackedMembers.delete(pid);
    }
    return living;
  };

  if (await captureOwnedProcessGroupMembers(leaderIdentity, trackedMembers)) {
    try {
      process.kill(-leaderIdentity.processGroup, "SIGTERM");
    } catch {
      // Exact identities below still cover members captured before this race.
    }
  } else {
    for (const identity of await livingMembers()) await signalIdentity(identity, "SIGTERM");
  }

  const started = Date.now();
  const escalationAt = started + Math.max(100, Math.floor(timeoutMs / 2));
  const deadline = started + timeoutMs;
  while (Date.now() < escalationAt) {
    await captureOwnedProcessGroupMembers(leaderIdentity, trackedMembers);
    if ((await livingMembers()).length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  for (const identity of await livingMembers()) await signalIdentity(identity, "SIGKILL");
  while (Date.now() < deadline) {
    if ((await livingMembers()).length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function packageVersion(name: string): string {
  return lockfile.packages[`node_modules/${name}`]?.version ?? "unknown";
}

export async function createSpikeServer(options: SpikeServerOptions): Promise<SpikeServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("The spike may bind only to loopback.");
  const port = options.port ?? 4173;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Port must be an integer from 0 to 65535.");
  const cwd = await validateGitTopLevel(options.cwd);
  const fixture = options.fixture === true;
  const executable = fixture ? process.execPath : await resolveExecutable(options.piPath ?? "pi");
  const statusExtension = resolve(moduleDirectory, "status-extension.ts");
  const askUserFixture = resolve(moduleDirectory, "ask-user-fixture.ts");
  await Promise.all([access(statusExtension), access(askUserFixture)]);

  const runtimeDirectory = await mkdtemp(join(tmpdir(), "pi-dash-terminal-spike-"));
  await chmod(runtimeDirectory, 0o700);
  const statusSocketPath = join(runtimeDirectory, "status.sock");
  const runtimeId = randomUUID();
  const statusToken = randomBytes(32).toString("base64url");
  const output = new OutputRing(options.outputBufferBytes ?? DEFAULT_BUFFER_BYTES);
  const diagnostics: Diagnostics = {
    websocketConnections: 0,
    statusConnections: 0,
    statusEventsAccepted: 0,
    statusEventsRejected: 0,
    malformedClientFrames: 0,
  };
  const websocketClients = new Set<ClientConnection>();
  const statusSockets = new Set<UnixSocket>();
  let status: StatusSnapshot = initialStatus();
  let lastStatusEvent: StatusEventFrame["event"] = "session_start";
  let statusCapability: "waiting" | "connected" | "degraded" = "waiting";
  let dimensions = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  let totalOutputBytes = 0;
  let runtime: RuntimeInfo = { state: "running", exitCode: null };
  let statusConnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;

  const broadcast = (frame: ServerFrame) => {
    for (const client of websocketClients) send(client.socket, frame);
  };
  const broadcastOutput = (frame: Extract<ServerFrame, { type: "output" }>) => {
    for (const client of websocketClients) {
      if (client.replayReady) send(client.socket, frame);
    }
  };

  const unixServer = createUnixServer((socket) => {
    statusSockets.add(socket);
    diagnostics.statusConnections = statusSockets.size;
    let authenticated = false;
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const frame = parseStatusFrame(line, runtimeId, statusToken);
        if (!frame) {
          diagnostics.statusEventsRejected++;
        } else {
          diagnostics.statusEventsAccepted++;
          authenticated = true;
          if (statusConnectTimer) clearTimeout(statusConnectTimer);
          statusConnectTimer = undefined;
          statusCapability = "connected";
          status = reduceStatus(status, frame);
          lastStatusEvent = frame.event;
          broadcast({
            v: PROTOCOL_VERSION,
            type: "status",
            event: frame.event,
            state: status.state,
            capability: statusCapability,
          });
        }
        newline = buffered.indexOf("\n");
      }
      if (Buffer.byteLength(buffered, "utf8") > STATUS_FRAME_BYTES) {
        diagnostics.statusEventsRejected++;
        socket.destroy();
      }
    });
    const removeSocket = () => {
      statusSockets.delete(socket);
      diagnostics.statusConnections = statusSockets.size;
      if (authenticated && statusSockets.size === 0 && runtime.state === "running") {
        statusCapability = "degraded";
        broadcast({
          v: PROTOCOL_VERSION,
          type: "status",
          event: lastStatusEvent,
          state: status.state,
          capability: statusCapability,
        });
      }
    };
    socket.once("close", removeSocket);
    socket.once("error", () => undefined);
  });
  unixServer.on("error", () => {
    statusCapability = "degraded";
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    unixServer.once("error", rejectListen);
    unixServer.listen(statusSocketPath, () => {
      unixServer.off("error", rejectListen);
      resolveListen();
    });
  });
  await chmod(statusSocketPath, 0o600);

  const args = fixture
    ? [resolve(moduleDirectory, "fake-terminal.ts")]
    : ["--extension", statusExtension, "--extension", askUserFixture];
  let ptyProcess: IPty;
  try {
    ptyProcess = pty.spawn(executable, args, {
      name: "xterm-256color",
      cols: dimensions.cols,
      rows: dimensions.rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "C.UTF-8",
        ...(fixture && options.disableStatusFixture
          ? {}
          : {
              PI_DASH_STATUS_SOCKET: statusSocketPath,
              PI_DASH_RUNTIME_ID: runtimeId,
              PI_DASH_STATUS_TOKEN: statusToken,
            }),
      },
    });
  } catch (error) {
    await closeUnixServer(unixServer, statusSockets);
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw error;
  }

  ptyProcess.onData((data) => {
    totalOutputBytes += Buffer.byteLength(data, "utf8");
    const entry = output.push(data);
    broadcastOutput({ v: PROTOCOL_VERSION, type: "output", seq: entry.seq, data: entry.data });
  });

  const leaderIdentity = process.platform === "linux" ? await readProcessIdentity(ptyProcess.pid) : undefined;
  const trackedProcessMembers = new Map<number, ProcessIdentity>();
  if (leaderIdentity) trackedProcessMembers.set(leaderIdentity.pid, leaderIdentity);
  let processTrackerBusy = false;
  let processTrackerInFlight = Promise.resolve();
  const trackOwnedProcessMembers = () => {
    if (!leaderIdentity || processTrackerBusy) return;
    processTrackerBusy = true;
    processTrackerInFlight = captureOwnedProcessGroupMembers(leaderIdentity, trackedProcessMembers)
      .then(() => undefined)
      .finally(() => {
        processTrackerBusy = false;
      });
  };
  if (leaderIdentity) await captureOwnedProcessGroupMembers(leaderIdentity, trackedProcessMembers);
  const processTracker = leaderIdentity ? setInterval(trackOwnedProcessMembers, 250) : undefined;
  processTracker?.unref?.();

  statusConnectTimer = setTimeout(() => {
    if (statusCapability !== "waiting") return;
    statusCapability = "degraded";
    broadcast({
      v: PROTOCOL_VERSION,
      type: "status",
      event: lastStatusEvent,
      state: status.state,
      capability: statusCapability,
    });
  }, 1_500);
  statusConnectTimer.unref?.();

  ptyProcess.onExit(({ exitCode }) => {
    if (processTracker) clearInterval(processTracker);
    void processTrackerInFlight.then(() => {
      if (leaderIdentity) trackedProcessMembers.delete(leaderIdentity.pid);
      runtime = { state: "exited", exitCode };
      broadcast({ v: PROTOCOL_VERSION, type: "runtime", ...runtime });
    });
  });

  const app = Fastify({ logger: false, bodyLimit: MAX_CLIENT_FRAME_BYTES });
  const failStartup = async (error: unknown): Promise<never> => {
    if (statusConnectTimer) clearTimeout(statusConnectTimer);
    if (processTracker) clearInterval(processTracker);
    await processTrackerInFlight;
    if (runtime.state === "running" || trackedProcessMembers.size > 0) {
      await waitForExit(
        ptyProcess,
        options.shutdownGraceMs ?? 2_000,
        leaderIdentity,
        trackedProcessMembers,
      );
    }
    await closeUnixServer(unixServer, statusSockets);
    await app.close().catch(() => undefined);
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw error;
  };
  try {
    await app.register(websocket, { options: { maxPayload: MAX_CLIENT_FRAME_BYTES } });
  } catch (error) {
    return failStartup(error);
  }

  app.get("/spike/terminal", { websocket: true }, (socket, request) => {
    if (!isAllowedOrigin(request.headers.origin)) {
      socket.close(1008, "Loopback origin required");
      return;
    }
    const client: ClientConnection = { socket, replayReady: false };
    websocketClients.add(client);
    diagnostics.websocketConnections = websocketClients.size;
    send(socket, {
      v: PROTOCOL_VERSION,
      type: "hello",
      runtimeId,
      earliestSeq: output.earliestSeq,
      latestSeq: output.latestSeq,
    });
    send(socket, { v: PROTOCOL_VERSION, type: "runtime", ...runtime });
    send(socket, {
      v: PROTOCOL_VERSION,
      type: "status",
      event: lastStatusEvent,
      state: status.state,
      capability: statusCapability,
    });

    socket.on("message", (raw) => {
      const text = raw.toString("utf8");
      if (Buffer.byteLength(text, "utf8") > MAX_CLIENT_FRAME_BYTES) {
        send(socket, { v: PROTOCOL_VERSION, type: "error", code: "FRAME_TOO_LARGE", message: "Client frame exceeds 64 KiB." });
        socket.close(1009, "Frame too large");
        return;
      }
      const parsed = parseClientFrame(text);
      if (!parsed.ok) {
        diagnostics.malformedClientFrames++;
        send(socket, { v: PROTOCOL_VERSION, type: "error", code: parsed.code, message: parsed.message });
        return;
      }
      const frame = parsed.frame;
      if (frame.type === "input") {
        if (runtime.state === "running") ptyProcess.write(frame.data);
      } else if (frame.type === "binaryInput") {
        if (runtime.state === "running") ptyProcess.write(Buffer.from(frame.dataBase64, "base64"));
      } else if (frame.type === "resize") {
        dimensions = { cols: frame.cols, rows: frame.rows };
        if (runtime.state === "running") ptyProcess.resize(frame.cols, frame.rows);
      } else if (frame.type === "replayFrom") {
        client.replayReady = false;
        if (!output.canReplayFrom(frame.seq)) {
          send(socket, {
            v: PROTOCOL_VERSION,
            type: "replayReset",
            earliestSeq: output.earliestSeq,
            latestSeq: output.latestSeq,
          });
          return;
        }

        const replayCutoff = output.latestSeq;
        for (const entry of output.replayFrom(frame.seq)) {
          if (entry.seq > replayCutoff) break;
          if (!send(socket, { v: PROTOCOL_VERSION, type: "output", seq: entry.seq, data: entry.data })) return;
        }
        client.replayReady = true;
        for (const entry of output.replayFrom(replayCutoff + 1)) {
          if (!send(socket, { v: PROTOCOL_VERSION, type: "output", seq: entry.seq, data: entry.data })) return;
        }
        if (runtime.state === "running" && dimensions.cols < 500) {
          ptyProcess.resize(dimensions.cols + 1, dimensions.rows);
          ptyProcess.resize(dimensions.cols, dimensions.rows);
        }
      }
    });
    socket.once("close", () => {
      websocketClients.delete(client);
      diagnostics.websocketConnections = websocketClients.size;
    });
    socket.once("error", () => undefined);
  });

  app.get("/spike/diagnostics", async () => ({
    runtime: { ...runtime, pid: ptyProcess.pid, cwd, fixture },
    terminal: {
      cols: dimensions.cols,
      rows: dimensions.rows,
      earliestSeq: output.earliestSeq,
      latestSeq: output.latestSeq,
      bufferedBytes: output.bytes,
      bufferedFrames: output.length,
      totalOutputBytes,
    },
    status: {
      capability: statusCapability,
      state: status.state,
      activeBlockingInteractions: status.blockingInteractions.size,
    },
    resources: { ...diagnostics, trackedProcessMembers: trackedProcessMembers.size },
    versions: {
      node: process.version,
      pi: fixture ? null : executable,
      fastify: packageVersion("fastify"),
      nodePty: packageVersion("node-pty"),
      xtermSvelte: packageVersion("@battlefieldduck/xterm-svelte"),
      xterm: packageVersion("@xterm/xterm"),
    },
  }));

  if (options.serveClient !== false) {
    try {
      await app.register(staticPlugin, {
        root: resolve(moduleDirectory, "../dist/client"),
        wildcard: false,
      });
    } catch (error) {
      return failStartup(error);
    }
  }

  try {
    await app.listen({ host, port });
  } catch (error) {
    return failStartup(error);
  }
  const addressInfo = app.server.address();
  const actualPort = typeof addressInfo === "object" && addressInfo ? addressInfo.port : port;
  const address = `http://${host === "::1" ? "[::1]" : host}:${actualPort}`;

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      if (statusConnectTimer) clearTimeout(statusConnectTimer);
      if (processTracker) clearInterval(processTracker);
      await processTrackerInFlight;
      for (const client of websocketClients) client.socket.close(1001, "Harness shutdown");
      websocketClients.clear();
      if (runtime.state === "running" || trackedProcessMembers.size > 0) {
        await waitForExit(
          ptyProcess,
          options.shutdownGraceMs ?? 2_000,
          leaderIdentity,
          trackedProcessMembers,
        );
      }
      await closeUnixServer(unixServer, statusSockets);
      await app.close();
      await rm(runtimeDirectory, { recursive: true, force: true });
    })();
    return closing;
  };

  return { app, address, runtimeId, runtimePid: ptyProcess.pid, statusSocketPath, close };
}

interface CliOptions extends SpikeServerOptions {
  help?: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const parsed: CliOptions = { cwd: "", host: "127.0.0.1", port: 4173, serveClient: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value after ${argument}`);
      return value;
    };
    if (argument === "--cwd") parsed.cwd = next();
    else if (argument === "--port") parsed.port = Number(next());
    else if (argument === "--host") parsed.host = next() as CliOptions["host"];
    else if (argument === "--pi") parsed.piPath = next();
    else if (argument === "--buffer-bytes") parsed.outputBufferBytes = Number(next());
    else if (argument === "--fixture") parsed.fixture = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!parsed.help && !parsed.cwd) throw new Error("--cwd /absolute/git/top-level is required.");
  return parsed;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: npm run dev -- --cwd /git/top-level [--pi /path/to/pi] [--port 4173] [--fixture]\n");
    return;
  }
  const server = await createSpikeServer(options);
  process.stdout.write(`Terminal spike listening at ${server.address}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`Terminal spike failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
