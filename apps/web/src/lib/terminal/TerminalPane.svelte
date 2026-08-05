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
  import { Cancel01Icon } from "@hugeicons/core-free-icons";
  import { HugeiconsIcon } from "@hugeicons/svelte";
  import { onDestroy, onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import * as Alert from "$lib/components/ui/alert";
  import { Button } from "$lib/components/ui/button";
  import { api } from "../../api.js";
  import type { TerminalControlsChange } from "./controls.js";
  import {
    encodeBinaryInput,
    isTerminalServerFrame,
    splitBinaryInput,
    splitUtf8Input,
    translateTerminalKey,
  } from "./protocol.js";

  export let worktree: WorktreeDto;
  export let workspaceName: string;
  export let kind: "pi" | "shell" = "pi";
  export let visible: boolean;
  export let maxFrameBytes: number;
  export let onControlsChange: (
    worktreeId: string,
    controls: Parameters<TerminalControlsChange>[0],
  ) => void;
  export let onAcknowledge: (worktreeId: string) => void = () => undefined;

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
    if (kind === "pi") onAcknowledge(worktree.id);
    const maximum = Math.max(128, Math.min(64 * 1024, maxFrameBytes - 256));
    for (const chunk of splitUtf8Input(data, maximum)) {
      send({ v: 1, type: "input", data: chunk });
    }
  }

  function sendBinaryInput(data: string): void {
    if (kind === "pi") onAcknowledge(worktree.id);
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
      toast.warning(
        `Older terminal output expired; ${kind === "pi" ? "Pi" : "the shell"} was asked to redraw the current screen.`,
      );
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
      `${scheme}://${location.host}/api/v1/worktrees/${encodeURIComponent(worktree.id)}/${kind === "pi" ? "terminal" : "shell-terminal"}/socket`,
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
      const response =
        kind === "pi"
          ? await api.startTerminal(worktree.id)
          : await api.startShellTerminal(worktree.id);
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
        error instanceof Error
          ? error.message
          : `Unable to start ${kind === "pi" ? "Pi" : "the shell"}.`;
      try {
        runtime =
          kind === "pi"
            ? (await api.terminal(worktree.id)).runtime
            : (await api.shellTerminal(worktree.id)).runtime;
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
      runtime =
        kind === "pi"
          ? (await api.stopTerminal(worktree.id)).runtime
          : (await api.stopShellTerminal(worktree.id)).runtime;
    } catch (error) {
      errorMessage =
        error instanceof Error
          ? error.message
          : `Unable to stop ${kind === "pi" ? "Pi" : "the shell"}.`;
    } finally {
      busy = false;
    }
  }

  async function restartRuntime(): Promise<void> {
    busy = true;
    errorMessage = "";
    try {
      restartKey ??= crypto.randomUUID();
      runtime =
        kind === "pi"
          ? (
              await api.restartTerminal(
                worktree.id,
                restartKey,
                runtime?.runtimeId ?? null,
              )
            ).runtime
          : (
              await api.restartShellTerminal(
                worktree.id,
                restartKey,
                runtime?.runtimeId ?? null,
              )
            ).runtime;
      restartKey = undefined;
      runtimeId = undefined;
      lastReceivedSeq = 0;
      lastAppliedSeq = 0;
      reconnectSocket();
    } catch (error) {
      errorMessage =
        error instanceof Error
          ? error.message
          : `Unable to restart ${kind === "pi" ? "Pi" : "the shell"}.`;
    } finally {
      busy = false;
    }
  }

  function focusTerminal(): void {
    terminal?.focus();
    if (kind === "pi") onAcknowledge(worktree.id);
  }

  function handleTerminalPointerDown(): void {
    if (visible) focusTerminal();
  }

  function handleHostKeydown(event: KeyboardEvent): void {
    if (kind !== "pi") return;
    if (!(event.target instanceof Node) || !host.contains(event.target)) return;
    const translated = translateTerminalKey(event);
    if (translated === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendTextInput(translated);
  }

  function handleTerminalKey(event: KeyboardEvent): boolean {
    if (
      event.type !== "keydown" ||
      !event.ctrlKey ||
      !event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.key.toLowerCase() !== "c"
    ) {
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    if (terminal?.hasSelection()) {
      void navigator.clipboard
        .writeText(terminal.getSelection())
        .catch(() => (errorMessage = "Unable to copy the terminal selection."));
    }
    return false;
  }

  async function handleLoad(loadedTerminal: Terminal): Promise<void> {
    terminal = loadedTerminal;
    if (disposed) {
      loadedTerminal.dispose();
      return;
    }
    try {
      loadedTerminal.attachCustomKeyEventHandler(handleTerminalKey);
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
      errorMessage = `This worktree must be ready and healthy before ${kind === "pi" ? "Pi" : "the shell"} can start.`;
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

<section
  class:flex={visible}
  class:hidden={!visible}
  data-testid="terminal-pane"
  class="terminal-pane size-full min-h-0 flex-col overflow-hidden bg-background"
>
  {#if errorMessage}
    <Alert.Root
      variant="destructive"
      class="rounded-none border-x-0 border-t-0"
      role="alert"
    >
      <Alert.Description>{errorMessage}</Alert.Description>
      <Alert.Action>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss terminal error"
          onclick={() => (errorMessage = "")}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </Alert.Action>
    </Alert.Root>
  {/if}

  <div
    class="terminal-region min-h-0 flex-1 overflow-hidden bg-background p-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset"
    bind:this={host}
    role="application"
    aria-label={`${workspaceName} ${worktree.name} interactive ${kind === "pi" ? "Pi" : "shell"} terminal`}
    on:pointerdown={handleTerminalPointerDown}
    on:focusin={() => visible && kind === "pi" && onAcknowledge(worktree.id)}
  >
    <Xterm
      class="terminal-emulator"
      data-testid="terminal-emulator"
      bind:terminal
      options={xtermOptions}
      onLoad={handleLoad}
      onData={sendTextInput}
      onBinary={sendBinaryInput}
      onResize={({ cols, rows }) => sendTerminalSize(cols, rows)}
      aria-label={kind === "pi"
        ? "Pi terminal emulator"
        : "Shell terminal emulator"}
    />
  </div>
</section>

<style>
  .terminal-region > :global(.terminal-emulator),
  .terminal-region :global(.xterm),
  :global(.xterm-scrollable-element) {
    height: 100% !important;
  }
</style>
