import {
  TERMINAL_PROTOCOL_VERSION,
  type RuntimeDto,
  type RuntimeLaunchError,
  type ShellActivityDto,
  type TerminalRuntimeState,
  type TerminalServerFrame,
} from "@pi-dash/contracts";
import type { IDisposable, IPty } from "node-pty";
import { OutputRing } from "./output-ring.js";
import {
  captureOwnedProcessDescendants,
  captureOwnedProcessMembers,
  readProcessIdentity,
  stopOwnedProcesses,
  type ProcessIdentity,
  type ProcessScope,
} from "./process-group.js";

export interface TerminalSocketTransport {
  readonly bufferedAmount: number;
  send(frame: TerminalServerFrame): void;
  close(code: number, reason: string): void;
}

interface ClientConnection {
  id: string;
  socket: TerminalSocketTransport;
  replayReady: boolean;
}

export interface TerminalLaunchSpec {
  executable: string;
  args: string[];
  env: Record<string, string>;
}

export interface TerminalRuntimeOptions {
  worktreeId: string;
  runtimeId: string;
  cwd: string;
  processScope?: ProcessScope;
  initialCols: number;
  initialRows: number;
  outputBufferBytes: number;
  maxSocketBufferedBytes: number;
  stopGraceMs: number;
  now: () => Date;
  onState?: (runtime: RuntimeDto) => void;
  onShellActivity?: (activity: ShellActivityDto) => void;
}

export class TerminalRuntime {
  readonly output: OutputRing;
  readonly clients = new Map<string, ClientConnection>();
  readonly trackedProcesses = new Map<number, ProcessIdentity>();
  readonly dto: RuntimeDto;
  #pty?: IPty;
  #dataListener?: IDisposable;
  #exitListener?: IDisposable;
  #leader?: ProcessIdentity;
  #tracker?: ReturnType<typeof setInterval>;
  #trackerInFlight = Promise.resolve();
  #trackerBusy = false;
  #trackerTicks = 0;
  #foregroundCommandActive = false;
  #inputOwner?: string;
  #stopRequested = false;
  #exitHandled = false;
  #dimensions: { cols: number; rows: number };

  constructor(readonly options: TerminalRuntimeOptions) {
    this.output = new OutputRing(options.outputBufferBytes);
    this.#dimensions = {
      cols: options.initialCols,
      rows: options.initialRows,
    };
    this.dto = {
      worktreeId: options.worktreeId,
      runtimeId: options.runtimeId,
      state: "starting",
      startedAt: null,
      exitedAt: null,
      exitCode: null,
      signal: null,
      launchError: null,
      attachedClients: 0,
    };
  }

  get ptyPid(): number | undefined {
    return this.#pty?.pid;
  }

  get snapshot(): RuntimeDto {
    return {
      ...this.dto,
      launchError: this.dto.launchError ? { ...this.dto.launchError } : null,
    };
  }

  #setState(
    state: TerminalRuntimeState,
    fields: Partial<
      Pick<RuntimeDto, "startedAt" | "exitedAt" | "exitCode" | "signal">
    > = {},
  ): void {
    this.dto.state = state;
    Object.assign(this.dto, fields);
    try {
      this.options.onState?.(this.snapshot);
    } catch {
      // Status/event observers must never interfere with the PTY lifecycle.
    }
    this.#broadcast({
      v: TERMINAL_PROTOCOL_VERSION,
      type: "runtime",
      runtime: this.snapshot,
    });
  }

  async start(launch: TerminalLaunchSpec, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const { spawn } = await import("node-pty");
    signal?.throwIfAborted();
    const pty = spawn(launch.executable, launch.args, {
      name: "xterm-256color",
      cols: this.#dimensions.cols,
      rows: this.#dimensions.rows,
      cwd: this.options.cwd,
      env: launch.env,
    });
    this.#pty = pty;
    this.#dataListener = pty.onData((data) => {
      const entry = this.output.push(data);
      for (const client of this.clients.values()) {
        if (client.replayReady) {
          this.#send(client, {
            v: TERMINAL_PROTOCOL_VERSION,
            type: "output",
            seq: entry.seq,
            data: entry.data,
            replay: false,
          });
        }
      }
    });
    this.#exitListener = pty.onExit(({ exitCode, signal }) => {
      void this.#handleExit(exitCode, signal ?? null);
    });

    if (process.platform === "linux") {
      this.#leader = await readProcessIdentity(pty.pid);
      signal?.throwIfAborted();
      if (
        !this.#leader ||
        this.#leader.processGroup !== pty.pid ||
        (this.options.processScope === "session" &&
          this.#leader.session !== pty.pid)
      ) {
        try {
          pty.kill("SIGKILL");
        } catch {
          // Process already exited while identity was checked.
        }
        throw new Error(
          this.options.processScope === "session"
            ? "PTY child is not the owned session leader"
            : "PTY child is not the owned process-group leader",
        );
      }
      this.trackedProcesses.set(this.#leader.pid, this.#leader);
      await captureOwnedProcessMembers(
        this.#leader,
        this.trackedProcesses,
        this.options.processScope,
      );
      signal?.throwIfAborted();
      this.#tracker = setInterval(() => this.#trackProcesses(), 250);
      this.#tracker.unref?.();
    }
    signal?.throwIfAborted();
    this.#setState("running", {
      startedAt: this.options.now().toISOString(),
    });
  }

  async failStart(error: RuntimeLaunchError): Promise<void> {
    this.dto.launchError = { ...error };
    this.#stopRequested = true;
    const cleaned = await this.#stopOwnedProcessTree();
    this.#setForegroundCommandActive(false);
    if (this.dto.state !== "crashed") {
      this.#setState("crashed", {
        exitedAt: this.dto.exitedAt ?? this.options.now().toISOString(),
        exitCode: null,
        signal: null,
      });
    }
    if (!cleaned) {
      throw new Error(
        "Owned terminal process tree did not exit after launch failure",
      );
    }
  }

  #setForegroundCommandActive(active: boolean): void {
    if (
      !this.options.onShellActivity ||
      this.#foregroundCommandActive === active
    ) {
      return;
    }
    this.#foregroundCommandActive = active;
    try {
      this.options.onShellActivity({
        worktreeId: this.options.worktreeId,
        runtimeId: this.options.runtimeId,
        foregroundCommandActive: active,
        changedAt: this.options.now().toISOString(),
      });
    } catch {
      // Application event observers must not interfere with PTY tracking.
    }
  }

  #trackProcesses(): void {
    if (!this.#leader || this.#trackerBusy) return;
    this.#trackerBusy = true;
    this.#trackerTicks += 1;
    const leader = this.#leader;
    const capture =
      this.#trackerTicks % 4 === 0
        ? captureOwnedProcessMembers
        : captureOwnedProcessDescendants;
    this.#trackerInFlight = Promise.all([
      capture(leader, this.trackedProcesses, this.options.processScope),
      this.options.onShellActivity
        ? readProcessIdentity(leader.pid)
        : Promise.resolve(undefined),
    ])
      .then(([, currentLeader]) => {
        if (!currentLeader) return;
        this.#setForegroundCommandActive(
          currentLeader.foregroundProcessGroup > 0 &&
            currentLeader.foregroundProcessGroup !== currentLeader.processGroup,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        this.#trackerBusy = false;
      });
  }

  async #handleExit(exitCode: number, signal: number | null): Promise<void> {
    if (this.#exitHandled) return;
    this.#exitHandled = true;
    if (this.#tracker) clearInterval(this.#tracker);
    await this.#trackerInFlight;
    this.#dataListener?.dispose();
    this.#exitListener?.dispose();
    this.#dataListener = undefined;
    this.#exitListener = undefined;
    this.#pty = undefined;
    const state = this.dto.launchError
      ? "crashed"
      : this.#stopRequested || exitCode === 0
        ? "stopped"
        : "crashed";
    this.#setForegroundCommandActive(false);
    this.#setState(state, {
      exitedAt: this.options.now().toISOString(),
      exitCode,
      signal,
    });
  }

  #send(client: ClientConnection, frame: TerminalServerFrame): boolean {
    const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (
      client.socket.bufferedAmount + frameBytes >
      this.options.maxSocketBufferedBytes
    ) {
      client.socket.close(1013, "Terminal client is not draining output");
      this.detach(client.id);
      return false;
    }
    try {
      client.socket.send(frame);
      return true;
    } catch {
      this.detach(client.id);
      return false;
    }
  }

  #broadcast(frame: TerminalServerFrame): void {
    for (const client of [...this.clients.values()]) this.#send(client, frame);
  }

  attach(
    connectionId: string,
    afterSeq: number,
    socket: TerminalSocketTransport,
  ): () => void {
    if (this.clients.has(connectionId))
      throw new Error("Connection is already attached");
    const client: ClientConnection = {
      id: connectionId,
      socket,
      replayReady: false,
    };
    this.clients.set(connectionId, client);
    this.#inputOwner ??= connectionId;
    this.dto.attachedClients = this.clients.size;
    this.#send(client, {
      v: TERMINAL_PROTOCOL_VERSION,
      type: "hello",
      runtime: this.snapshot,
      connectionId,
      inputOwner: this.#inputOwner === connectionId,
      earliestSeq: this.output.earliestSeq,
      latestSeq: this.output.latestSeq,
    });

    let replayAfter = afterSeq;
    const replayExpired = !this.output.canReplayAfter(afterSeq);
    if (replayExpired) {
      this.#send(client, {
        v: TERMINAL_PROTOCOL_VERSION,
        type: "replayReset",
        earliestSeq: this.output.earliestSeq,
        latestSeq: this.output.latestSeq,
      });
      replayAfter = this.output.earliestSeq - 1;
    }
    const cutoff = this.output.latestSeq;
    for (const entry of this.output.replayAfter(replayAfter)) {
      if (entry.seq > cutoff) break;
      if (
        !this.#send(client, {
          v: TERMINAL_PROTOCOL_VERSION,
          type: "output",
          seq: entry.seq,
          data: entry.data,
          replay: true,
        })
      ) {
        return () => undefined;
      }
    }
    client.replayReady = true;
    for (const entry of this.output.replayAfter(cutoff)) {
      if (
        !this.#send(client, {
          v: TERMINAL_PROTOCOL_VERSION,
          type: "output",
          seq: entry.seq,
          data: entry.data,
          replay: false,
        })
      ) {
        return () => undefined;
      }
    }
    if (replayExpired && this.dto.state === "running" && this.#pty) {
      const nudgedCols =
        this.#dimensions.cols < 500
          ? this.#dimensions.cols + 1
          : this.#dimensions.cols - 1;
      this.#pty.resize(nudgedCols, this.#dimensions.rows);
      this.#pty.resize(this.#dimensions.cols, this.#dimensions.rows);
    }
    return () => this.detach(connectionId);
  }

  detach(connectionId: string): void {
    if (!this.clients.delete(connectionId)) return;
    if (this.#inputOwner === connectionId) this.#inputOwner = undefined;
    this.dto.attachedClients = this.clients.size;
  }

  input(connectionId: string, data: string | Buffer): boolean {
    if (this.#inputOwner !== connectionId) return false;
    if (this.dto.state !== "running" || !this.#pty) return true;
    this.#pty.write(data);
    return true;
  }

  resize(connectionId: string, cols: number, rows: number): boolean {
    if (this.#inputOwner !== connectionId) return false;
    this.#dimensions = { cols, rows };
    if (this.dto.state === "running" && this.#pty) this.#pty.resize(cols, rows);
    return true;
  }

  async #stopOwnedProcessTree(): Promise<boolean> {
    if (!this.#pty && this.trackedProcesses.size === 0) return true;
    if (this.#tracker) clearInterval(this.#tracker);
    await this.#trackerInFlight;
    const cleaned = await stopOwnedProcesses({
      pty: this.#pty,
      leader: this.#leader,
      tracked: this.trackedProcesses,
      timeoutMs: this.options.stopGraceMs,
      scope: this.options.processScope,
    });
    if (cleaned) this.trackedProcesses.clear();
    return cleaned;
  }

  async stop(): Promise<void> {
    this.#stopRequested = true;
    this.dto.launchError = null;
    if (!this.#pty && this.trackedProcesses.size === 0) {
      if (this.dto.state !== "stopped") {
        this.#setState("stopped", {
          exitedAt: this.dto.exitedAt ?? this.options.now().toISOString(),
        });
      }
      return;
    }
    this.#setState("stopping");
    if (!(await this.#stopOwnedProcessTree())) {
      throw new Error(
        "Owned terminal process tree did not exit before deadline",
      );
    }
    this.#setForegroundCommandActive(false);
    this.#setState("stopped", {
      exitedAt: this.dto.exitedAt ?? this.options.now().toISOString(),
    });
  }

  closeClients(code = 1001, reason = "Terminal runtime disposed"): void {
    for (const client of this.clients.values())
      client.socket.close(code, reason);
    this.clients.clear();
    this.#inputOwner = undefined;
    this.dto.attachedClients = 0;
  }

  dispose(): void {
    if (this.#tracker) clearInterval(this.#tracker);
    this.#dataListener?.dispose();
    this.#exitListener?.dispose();
    this.#dataListener = undefined;
    this.#exitListener = undefined;
    this.closeClients();
  }
}
