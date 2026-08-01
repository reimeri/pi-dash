<script lang="ts">
  import { Xterm } from "@battlefieldduck/xterm-svelte";
  import {
    TERMINAL_MAX_COLS,
    TERMINAL_MAX_ROWS,
    TERMINAL_MIN_COLS,
    TERMINAL_MIN_ROWS,
    type RuntimeDto,
    type TerminalServerFrame,
    type WorktreeDto,
  } from "@pi-dash/contracts";
  import type { Terminal } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import { onDestroy, onMount } from "svelte";
  import { api } from "../../api.js";
  import type { TerminalControlsChange } from "./controls.js";
  import {
    encodeBinaryInput,
    isTerminalServerFrame,
    splitBinaryInput,
    splitUtf8Input,
    translateModifiedEnter,
  } from "./protocol.js";

  export let worktree: WorktreeDto;
  export let workspaceName: string;
  export let visible: boolean;
  export let maxFrameBytes: number;
  export let onControlsChange: (
    worktreeId: string,
    controls: Parameters<TerminalControlsChange>[0],
  ) => void;

  let host: HTMLDivElement;
  let terminal: Terminal | undefined;
  let fitAddon: import("@xterm/addon-fit").FitAddon | undefined;
  let unicodeAddon: import("@xterm/addon-unicode11").Unicode11Addon | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectAttempts = 0;
  let restartKey: string | undefined;
  let disposed = false;
  let intentionalClose = false;
  let connection: "connecting" | "connected" | "disconnected" = "connecting";
  let runtime: RuntimeDto | undefined;
  let runtimeId: string | undefined;
  let inputOwner = false;
  let inputOwnerKnown = false;
  let busy = false;
  let errorMessage = "";
  let lastReceivedSeq = 0;
  let lastAppliedSeq = 0;
  let pendingBytes = 0;
  let activeBytes = 0;
  let writeActive = false;
  let outputGeneration = 0;
  const pendingOutput: Array<{ seq: number; data: string; bytes: number }> = [];
  const encoder = new TextEncoder();
  const MAX_PENDING_BYTES = 16 * 1024 * 1024;

  const xtermOptions = {
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily:
      '"JetBrains Mono", "Cascadia Code", "Liberation Mono", monospace',
    fontSize: 14,
    lineHeight: 1.18,
    scrollback: 10_000,
    theme: {
      background: "#09090b",
      foreground: "#e4e4e7",
      cursor: "#fafafa",
      selectionBackground: "#3f3f46",
    },
  };

  $: if (visible) {
    onControlsChange(worktree.id, {
      runtimeState: runtime?.state ?? "starting",
      socketState: connection,
      inputOwner,
      inputOwnerKnown,
      busy,
      focus: focusTerminal,
      start: startRuntime,
      stop: stopRuntime,
      restart: restartRuntime,
    });
    scheduleFit();
  }

  function scheduleFit(): void {
    requestAnimationFrame(() => {
      if (
        !disposed &&
        visible &&
        host?.clientWidth > 0 &&
        host.clientHeight > 0
      ) {
        fitAddon?.fit();
      }
    });
  }

  function send(frame: object): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  function sendTerminalSize(
    cols: number | undefined = terminal?.cols,
    rows: number | undefined = terminal?.rows,
  ): void {
    if (
      !inputOwnerKnown ||
      !inputOwner ||
      cols === undefined ||
      !Number.isInteger(cols) ||
      cols < TERMINAL_MIN_COLS ||
      cols > TERMINAL_MAX_COLS ||
      rows === undefined ||
      !Number.isInteger(rows) ||
      rows < TERMINAL_MIN_ROWS ||
      rows > TERMINAL_MAX_ROWS
    ) {
      return;
    }
    send({ v: 1, type: "resize", cols, rows });
  }

  function sendTextInput(data: string): void {
    const maximum = Math.max(128, Math.min(64 * 1024, maxFrameBytes - 256));
    for (const chunk of splitUtf8Input(data, maximum)) {
      send({ v: 1, type: "input", data: chunk });
    }
  }

  function sendBinaryInput(data: string): void {
    const maximum = Math.max(
      64,
      Math.floor((Math.min(64 * 1024, maxFrameBytes - 256) * 3) / 4),
    );
    for (const chunk of splitBinaryInput(data, maximum)) {
      send({
        v: 1,
        type: "binaryInput",
        dataBase64: encodeBinaryInput(chunk),
      });
    }
  }

  function resetOutput(sequence: number): void {
    outputGeneration += 1;
    pendingOutput.length = 0;
    pendingBytes = 0;
    activeBytes = 0;
    writeActive = false;
    lastReceivedSeq = sequence;
    lastAppliedSeq = sequence;
    terminal?.reset();
  }

  function flushOutput(): void {
    if (!terminal || writeActive) return;
    const entry = pendingOutput.shift();
    if (!entry) return;
    writeActive = true;
    activeBytes = entry.bytes;
    const generation = outputGeneration;
    terminal.write(entry.data, () => {
      if (generation !== outputGeneration) return;
      pendingBytes -= entry.bytes;
      activeBytes = 0;
      lastAppliedSeq = entry.seq;
      writeActive = false;
      flushOutput();
    });
  }

  function queueOutput(seq: number, data: string): void {
    if (seq <= lastReceivedSeq) return;
    if (seq !== lastReceivedSeq + 1) {
      errorMessage = `Terminal output sequence gap at ${seq}; reconnecting.`;
      socket?.close(1013, "Output sequence gap");
      return;
    }
    const bytes = encoder.encode(data).byteLength;
    lastReceivedSeq = seq;
    pendingOutput.push({ seq, data, bytes });
    pendingBytes += bytes;
    if (pendingBytes > MAX_PENDING_BYTES) {
      errorMessage =
        "Terminal rendering fell behind; reconnecting from applied output.";
      pendingOutput.length = 0;
      pendingBytes = activeBytes;
      lastReceivedSeq = lastAppliedSeq;
      socket?.close(1013, "Renderer backlog exceeded");
      return;
    }
    flushOutput();
  }

  function handleFrame(frame: TerminalServerFrame): void {
    if (frame.type === "hello") {
      runtime = frame.runtime;
      inputOwner = frame.inputOwner;
      inputOwnerKnown = true;
      if (inputOwner) sendTerminalSize();
      if (runtimeId !== frame.runtime.runtimeId) {
        runtimeId = frame.runtime.runtimeId ?? undefined;
        resetOutput(frame.earliestSeq - 1);
      }
    } else if (frame.type === "output") {
      queueOutput(frame.seq, frame.data);
    } else if (frame.type === "replayReset") {
      resetOutput(frame.earliestSeq - 1);
      errorMessage =
        "Older terminal output expired; Pi was asked to redraw the current screen.";
    } else if (frame.type === "runtime") {
      if (runtime) {
        runtime = {
          ...runtime,
          state: frame.state,
          exitCode: frame.exitCode,
          signal: frame.signal,
        };
      }
    } else if (frame.type === "error") {
      errorMessage = `${frame.code}: ${frame.message}`;
    }
  }

  function connectSocket(): void {
    if (disposed || socket) return;
    intentionalClose = false;
    connection = "connecting";
    inputOwnerKnown = false;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const candidate = new WebSocket(
      `${scheme}://${location.host}/api/v1/worktrees/${encodeURIComponent(worktree.id)}/terminal/socket`,
    );
    socket = candidate;
    candidate.addEventListener("open", () => {
      if (socket !== candidate) return;
      reconnectAttempts = 0;
      connection = "connected";
      send({ v: 1, type: "attach", afterSeq: lastAppliedSeq });
      heartbeatTimer = setInterval(() => {
        send({ v: 1, type: "ping", nonce: crypto.randomUUID() });
      }, 20_000);
    });
    candidate.addEventListener("message", (event) => {
      let value: unknown;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        errorMessage = "The daemon sent malformed terminal data.";
        return;
      }
      if (!isTerminalServerFrame(value)) {
        errorMessage = "The daemon sent an invalid terminal frame.";
        return;
      }
      handleFrame(value);
    });
    candidate.addEventListener("close", (event) => {
      if (socket !== candidate) return;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      socket = undefined;
      connection = "disconnected";
      inputOwnerKnown = false;
      const permanent = [1000, 1001, 1002, 1008].includes(event.code);
      if (
        !disposed &&
        !intentionalClose &&
        !permanent &&
        reconnectAttempts < 10 &&
        !reconnectTimer
      ) {
        const delay =
          Math.min(10_000, 500 * 2 ** reconnectAttempts) +
          Math.floor(Math.random() * 250);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connectSocket();
        }, delay);
      }
    });
    candidate.addEventListener("error", () => {
      connection = "disconnected";
    });
  }

  function reconnectSocket(): void {
    intentionalClose = true;
    socket?.close(1012, "Runtime changed");
    socket = undefined;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    setTimeout(() => {
      if (!disposed) connectSocket();
    }, 0);
  }

  async function startRuntime(): Promise<void> {
    busy = true;
    errorMessage = "";
    try {
      const previousRuntimeId = runtime?.runtimeId;
      const response = await api.startTerminal(worktree.id);
      runtime = response.runtime;
      if (response.runtime.runtimeId !== previousRuntimeId) {
        runtimeId = undefined;
        lastReceivedSeq = 0;
        lastAppliedSeq = 0;
        reconnectSocket();
      } else {
        connectSocket();
      }
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : "Unable to start Pi.";
      try {
        runtime = (await api.terminal(worktree.id)).runtime;
      } catch {
        // Keep the sanitized startup error already shown.
      }
    } finally {
      busy = false;
    }
  }

  async function stopRuntime(): Promise<void> {
    busy = true;
    errorMessage = "";
    try {
      runtime = (await api.stopTerminal(worktree.id)).runtime;
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : "Unable to stop Pi.";
    } finally {
      busy = false;
    }
  }

  async function restartRuntime(): Promise<void> {
    busy = true;
    errorMessage = "";
    try {
      restartKey ??= crypto.randomUUID();
      runtime = (await api.restartTerminal(worktree.id, restartKey)).runtime;
      restartKey = undefined;
      runtimeId = undefined;
      lastReceivedSeq = 0;
      lastAppliedSeq = 0;
      reconnectSocket();
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : "Unable to restart Pi.";
    } finally {
      busy = false;
    }
  }

  function focusTerminal(): void {
    terminal?.focus();
  }

  function handleHostKeydown(event: KeyboardEvent): void {
    if (!(event.target instanceof Node) || !host.contains(event.target)) return;
    const translated = translateModifiedEnter(event);
    if (translated === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendTextInput(translated);
  }

  async function handleLoad(loadedTerminal: Terminal): Promise<void> {
    terminal = loadedTerminal;
    if (disposed) {
      loadedTerminal.dispose();
      return;
    }
    try {
      const [{ FitAddon }, { Unicode11Addon }] = await Promise.all([
        import("@xterm/addon-fit"),
        import("@xterm/addon-unicode11"),
      ]);
      if (disposed) return;
      fitAddon = new FitAddon();
      unicodeAddon = new Unicode11Addon();
      loadedTerminal.loadAddon(fitAddon);
      loadedTerminal.loadAddon(unicodeAddon);
      loadedTerminal.unicode.activeVersion = "11";
      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(host);
      await document.fonts?.ready;
      scheduleFit();
      flushOutput();
      if (visible) loadedTerminal.focus();
    } catch (error) {
      errorMessage = `Terminal initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  onMount(() => {
    window.addEventListener("keydown", handleHostKeydown, { capture: true });
    if (worktree.lifecycle === "ready" && worktree.health === "healthy") {
      void startRuntime();
    } else {
      errorMessage =
        "This worktree must be ready and healthy before Pi can start.";
    }
  });

  onDestroy(() => {
    disposed = true;
    intentionalClose = true;
    outputGeneration += 1;
    pendingOutput.length = 0;
    window.removeEventListener("keydown", handleHostKeydown, { capture: true });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    reconnectTimer = undefined;
    heartbeatTimer = undefined;
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    fitAddon?.dispose();
    unicodeAddon?.dispose();
    fitAddon = undefined;
    unicodeAddon = undefined;
    terminal?.dispose();
    terminal = undefined;
    onControlsChange(worktree.id, undefined);
    socket?.close(1000, "Terminal pane evicted");
    socket = undefined;
  });
</script>

<section class:hidden={!visible} class="terminal-pane">
  {#if errorMessage}
    <div class="terminal-alert" role="alert">
      <span>{errorMessage}</span>
      <button
        type="button"
        aria-label="Dismiss terminal error"
        on:click={() => (errorMessage = "")}>×</button
      >
    </div>
  {/if}

  <div
    class="terminal-region"
    bind:this={host}
    role="application"
    aria-label={`${workspaceName} ${worktree.name} interactive Pi terminal`}
  >
    <Xterm
      class="terminal-emulator"
      bind:terminal
      options={xtermOptions}
      onLoad={handleLoad}
      onData={sendTextInput}
      onBinary={sendBinaryInput}
      onResize={({ cols, rows }) => sendTerminalSize(cols, rows)}
      aria-label="Pi terminal emulator"
    />
  </div>
</section>

<style>
  .terminal-pane {
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    flex-direction: column;
    background: #09090b;
    overflow: hidden;
  }

  .terminal-pane.hidden {
    display: none;
  }

  .terminal-alert {
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: #fecaca;
    background: #2a1215;
    border-bottom: 1px solid #7f1d1d;
    font-size: 13px;
  }

  .terminal-alert button {
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .terminal-region {
    min-height: 0;
    flex: 1;
    padding: 8px;
    overflow: hidden;
    background: #09090b;
  }

  .terminal-region > :global(.terminal-emulator),
  .terminal-region :global(.xterm) {
    height: 100%;
  }

  .terminal-region:focus-within {
    outline: 2px solid #3b82f6;
    outline-offset: -2px;
  }
</style>
