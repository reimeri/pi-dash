<script lang="ts">
  import { Xterm } from "@battlefieldduck/xterm-svelte";
  import type { Terminal } from "@xterm/xterm";
  import { onDestroy, onMount } from "svelte";
  import { diagnostics } from "./browser-diagnostics.js";
  import { translateModifiedEnter } from "./key-translation.js";
  import {
    PROTOCOL_VERSION,
    encodeBinaryInput,
    isServerFrame,
    type AttentionState,
    type RuntimeState,
    type ServerFrame,
  } from "./protocol.js";

  export let onConnection: (state: "connecting" | "connected" | "disconnected") => void;
  export let onRuntime: (state: RuntimeState, exitCode: number | null) => void;
  export let onAttention: (
    state: AttentionState,
    event: string,
    capability: "waiting" | "connected" | "degraded",
  ) => void;
  export let onError: (message: string) => void;

  let terminal: Terminal | undefined;
  let host: HTMLDivElement;
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let fitAddon: import("@xterm/addon-fit").FitAddon | undefined;
  let unicodeAddon: import("@xterm/addon-unicode11").Unicode11Addon | undefined;
  let disposed = false;
  let socketCounted = false;
  let runtimeId: string | undefined;
  let lastReceivedSeq = 0;
  let lastAppliedSeq = 0;
  let pendingOutputBytes = 0;
  let activeOutputBytes = 0;
  let writeActive = false;
  let outputGeneration = 0;
  let pendingReset:
    | { sequence: number | null; requestReplay: boolean; message?: string }
    | undefined;
  const pendingOutput: Array<{ seq: number; data: string; bytes: number }> = [];
  const textEncoder = new TextEncoder();
  const stats = diagnostics();
  const MAX_PENDING_OUTPUT_BYTES = 16 * 1024 * 1024;

  const options = {
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: '"JetBrains Mono", "Cascadia Code", "Liberation Mono", monospace',
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

  function send(frame: object): boolean {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  function sendInput(data: string): void {
    send({ v: PROTOCOL_VERSION, type: "input", data });
  }

  function handleData(data: string): void {
    sendInput(data);
  }

  function handleBinary(data: string): void {
    send({ v: PROTOCOL_VERSION, type: "binaryInput", dataBase64: encodeBinaryInput(data) });
  }

  function handleResize(size: { cols: number; rows: number }): void {
    if (size.cols > 0 && size.rows > 0) {
      send({ v: PROTOCOL_VERSION, type: "resize", cols: size.cols, rows: size.rows });
    }
  }

  function handleHostKeydown(event: KeyboardEvent): void {
    if (!(event.target instanceof Node) || !host.contains(event.target)) return;
    const translated = translateModifiedEnter(event);
    if (translated === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.shiftKey) stats.translatedShiftEnter++;
    if (event.altKey) stats.translatedAltEnter++;
    sendInput(translated);
  }

  function finishOutputReset(): void {
    if (!pendingReset || writeActive) return;
    const reset = pendingReset;
    pendingReset = undefined;
    const sequence = reset.sequence ?? lastAppliedSeq;
    outputGeneration++;
    pendingOutput.length = 0;
    pendingOutputBytes = 0;
    activeOutputBytes = 0;
    lastReceivedSeq = sequence;
    lastAppliedSeq = sequence;
    terminal?.reset();
    if (reset.message) onError(reset.message);
    if (reset.requestReplay) {
      send({ v: PROTOCOL_VERSION, type: "replayFrom", seq: sequence + 1 });
    }
  }

  function requestOutputReset(
    sequence: number | null,
    requestReplay: boolean,
    message: string | undefined = undefined,
  ): void {
    pendingReset = { sequence, requestReplay, message };
    pendingOutput.length = 0;
    pendingOutputBytes = activeOutputBytes;
    finishOutputReset();
  }

  function flushOutput(): void {
    if (!terminal || writeActive || pendingReset) return;
    const entry = pendingOutput.shift();
    if (!entry) return;
    writeActive = true;
    activeOutputBytes = entry.bytes;
    const generation = outputGeneration;
    terminal.write(entry.data, () => {
      if (generation !== outputGeneration) return;
      pendingOutputBytes -= entry.bytes;
      activeOutputBytes = 0;
      lastAppliedSeq = entry.seq;
      writeActive = false;
      if (pendingReset) finishOutputReset();
      else flushOutput();
    });
  }

  function queueOutput(seq: number, data: string): void {
    if (pendingReset || seq <= lastReceivedSeq) return;
    if (seq !== lastReceivedSeq + 1) {
      requestOutputReset(
        null,
        false,
        `Terminal output sequence gap: expected ${lastReceivedSeq + 1}, received ${seq}.`,
      );
      socket?.close(1013, "Terminal output sequence gap");
      return;
    }
    const bytes = textEncoder.encode(data).byteLength;
    lastReceivedSeq = seq;
    pendingOutput.push({ seq, data, bytes });
    pendingOutputBytes += bytes;
    if (pendingOutputBytes > MAX_PENDING_OUTPUT_BYTES) {
      requestOutputReset(
        null,
        false,
        "Terminal renderer fell behind; reconnecting from the last applied frame.",
      );
      socket?.close(1013, "Terminal renderer backlog exceeded");
      return;
    }
    flushOutput();
  }

  function handleFrame(frame: ServerFrame): void {
    if (frame.type === "hello") {
      const sameRuntime = runtimeId === frame.runtimeId;
      if (!sameRuntime) {
        runtimeId = frame.runtimeId;
        requestOutputReset(frame.earliestSeq - 1, true);
      } else if (pendingReset) {
        pendingReset.requestReplay = true;
        finishOutputReset();
      } else {
        send({ v: PROTOCOL_VERSION, type: "replayFrom", seq: lastReceivedSeq + 1 });
      }
    } else if (frame.type === "output") {
      queueOutput(frame.seq, frame.data);
    } else if (frame.type === "replayReset") {
      requestOutputReset(
        frame.earliestSeq - 1,
        true,
        "Replay buffer wrapped; the terminal was reset and a redraw was requested.",
      );
    } else if (frame.type === "runtime") {
      onRuntime(frame.state, frame.exitCode);
    } else if (frame.type === "status") {
      onAttention(frame.state, frame.event, frame.capability);
    } else if (frame.type === "error") {
      onError(`${frame.code}: ${frame.message}`);
    }
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      stats.reconnects++;
      connect();
    }, 400);
  }

  function connect(): void {
    if (disposed) return;
    onConnection("connecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const candidate = new WebSocket(`${scheme}://${location.host}/spike/terminal`);
    socket = candidate;
    socketCounted = true;
    stats.activeSockets++;
    candidate.addEventListener("open", () => {
      if (socket === candidate) onConnection("connected");
    });
    candidate.addEventListener("message", (event) => {
      let value: unknown;
      try {
        value = JSON.parse(String(event.data));
      } catch {
        stats.malformedServerFrames++;
        onError("Ignored malformed server JSON.");
        return;
      }
      if (!isServerFrame(value)) {
        stats.malformedServerFrames++;
        onError("Ignored an invalid server frame.");
        return;
      }
      handleFrame(value);
    });
    candidate.addEventListener("close", () => {
      if (socketCounted) {
        socketCounted = false;
        stats.activeSockets--;
      }
      if (socket === candidate) socket = undefined;
      if (!disposed) {
        onConnection("disconnected");
        scheduleReconnect();
      }
    });
    candidate.addEventListener("error", () => onConnection("disconnected"));
  }

  async function handleLoad(loadedTerminal: Terminal): Promise<void> {
    terminal = loadedTerminal;
    if (disposed) {
      loadedTerminal.dispose();
      return;
    }
    stats.activeTerminals++;
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
      stats.activeAddons += 2;
      resizeObserver = new ResizeObserver(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) fitAddon?.fit();
      });
      resizeObserver.observe(host);
      stats.activeObservers++;
      fitAddon.fit();
      flushOutput();
      loadedTerminal.focus();
    } catch (error) {
      onError(`Terminal initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function focusTerminal(): void {
    terminal?.focus();
  }

  onMount(() => {
    stats.mounts++;
    window.addEventListener("keydown", handleHostKeydown, { capture: true });
    connect();
  });

  onDestroy(() => {
    disposed = true;
    outputGeneration++;
    pendingOutput.length = 0;
    pendingOutputBytes = 0;
    activeOutputBytes = 0;
    writeActive = false;
    pendingReset = undefined;
    window.removeEventListener("keydown", handleHostKeydown, { capture: true });
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    resizeObserver?.disconnect();
    if (resizeObserver) stats.activeObservers--;
    resizeObserver = undefined;
    fitAddon?.dispose();
    unicodeAddon?.dispose();
    if (fitAddon) stats.activeAddons--;
    if (unicodeAddon) stats.activeAddons--;
    fitAddon = undefined;
    unicodeAddon = undefined;
    if (terminal) {
      terminal.dispose();
      terminal = undefined;
      stats.activeTerminals--;
    }
    if (socketCounted) {
      socketCounted = false;
      stats.activeSockets--;
    }
    socket?.close(1000, "Terminal unmounted");
    socket = undefined;
  });
</script>

<div class="terminal-shell">
  <div class="terminal-actions">
    <span>Keyboard path: Tab to this button, then Enter</span>
    <button type="button" on:click={focusTerminal}>Focus terminal</button>
  </div>
  <div
    class="terminal-region"
    bind:this={host}
    role="application"
    aria-label="Interactive Pi terminal"
    data-testid="terminal-region"
  >
    <Xterm
      bind:terminal
      {options}
      onLoad={handleLoad}
      onData={handleData}
      onBinary={handleBinary}
      onResize={handleResize}
      aria-label="Pi terminal emulator"
    />
  </div>
</div>
