import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { NativeDialogMode } from "./platform/native-directory-dialog.js";

export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  host: string;
  port: number;
  dataDir?: string;
  configDir?: string;
  runtimeDir?: string;
  piExecutable: string;
  piMinimumVersion: string;
  terminalInitialCols: number;
  terminalInitialRows: number;
  terminalOutputBufferBytes: number;
  terminalMaxFrameBytes: number;
  terminalMaxSocketBufferedBytes: number;
  terminalStopGraceMs: number;
  terminalCacheSize: number;
  nativeDialog: NativeDialogMode;
  logLevel: LogLevel;
  uiOrigin?: string;
  staticDir?: string;
  bootstrapOutput?: string;
  desktopControlToken?: string;
  openBrowser: boolean;
  mode: "development" | "production" | "test";
}

interface ConfigFile {
  host?: string;
  port?: number;
  dataDir?: string;
  runtimeDir?: string;
  piExecutable?: string;
  piMinimumVersion?: string;
  terminalInitialCols?: number;
  terminalInitialRows?: number;
  terminalOutputBufferBytes?: number;
  terminalMaxFrameBytes?: number;
  terminalMaxSocketBufferedBytes?: number;
  terminalStopGraceMs?: number;
  terminalCacheSize?: number;
  nativeDialog?: NativeDialogMode;
  logLevel?: LogLevel;
  uiOrigin?: string;
  staticDir?: string;
  bootstrapOutput?: string;
}
type CliValues = Record<string, string>;

const configFileKeys = new Set([
  "host",
  "port",
  "dataDir",
  "runtimeDir",
  "piExecutable",
  "piMinimumVersion",
  "terminalInitialCols",
  "terminalInitialRows",
  "terminalOutputBufferBytes",
  "terminalMaxFrameBytes",
  "terminalMaxSocketBufferedBytes",
  "terminalStopGraceMs",
  "terminalCacheSize",
  "nativeDialog",
  "logLevel",
  "uiOrigin",
  "staticDir",
  "bootstrapOutput",
]);

const cliNames = new Set([
  "host",
  "port",
  "data-dir",
  "config-dir",
  "runtime-dir",
  "pi-executable",
  "pi-minimum-version",
  "terminal-initial-cols",
  "terminal-initial-rows",
  "terminal-output-buffer-bytes",
  "terminal-max-frame-bytes",
  "terminal-max-socket-buffered-bytes",
  "terminal-stop-grace-ms",
  "terminal-cache-size",
  "native-dialog",
  "log-level",
  "ui-origin",
  "static-dir",
  "bootstrap-output",
  "no-open",
]);

const cliFlags = new Set(["no-open"]);

function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function parseCli(args: readonly string[]): CliValues {
  const values: CliValues = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--"))
      throw new Error(`Unexpected argument: ${argument ?? ""}`);
    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    if (!rawName || !cliNames.has(rawName))
      throw new Error(`Unknown option: --${rawName ?? ""}`);
    if (cliFlags.has(rawName)) {
      if (inlineValue !== undefined)
        throw new Error(`Option --${rawName} does not accept a value`);
      values[rawName] = "true";
      continue;
    }
    const value = inlineValue ?? args[index + 1];
    if (!value || (inlineValue === undefined && value.startsWith("--"))) {
      throw new Error(`Missing value for --${rawName}`);
    }
    values[rawName] = value;
    if (inlineValue === undefined) index += 1;
  }
  return values;
}

function readConfigFile(configDir: string): ConfigFile {
  const file = resolve(configDir, "config.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("config root must be an object");
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!configFileKeys.has(key))
        throw new Error(`unknown config key: ${key}`);
      if (
        [
          "port",
          "terminalInitialCols",
          "terminalInitialRows",
          "terminalOutputBufferBytes",
          "terminalMaxFrameBytes",
          "terminalMaxSocketBufferedBytes",
          "terminalStopGraceMs",
          "terminalCacheSize",
        ].includes(key)
      ) {
        if (typeof value !== "number")
          throw new Error(`config ${key} must be a number`);
      } else if (key === "logLevel") {
        if (
          typeof value !== "string" ||
          !LOG_LEVELS.includes(value as LogLevel)
        ) {
          throw new Error("config logLevel is invalid");
        }
      } else if (key === "nativeDialog") {
        if (
          typeof value !== "string" ||
          !["auto", "zenity", "kdialog", "disabled"].includes(value)
        ) {
          throw new Error("config nativeDialog is invalid");
        }
      } else if (typeof value !== "string" || value.length === 0) {
        throw new Error(`config ${key} must be a non-empty string`);
      }
    }
    return parsed as ConfigFile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new Error(`Unable to load config.json: ${(error as Error).message}`);
  }
}

function pick(
  ...values: Array<string | number | undefined>
): string | number | undefined {
  return values.find((value) => value !== undefined);
}

function parseInteger(
  name: string,
  value: string | number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function parsePort(value: string | number | undefined): number {
  return parseInteger("Port", value, 4317, 1, 65_535);
}

export function isLoopbackHost(host: string): boolean {
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  return host === "::1" || host.toLowerCase() === "0:0:0:0:0:0:0:1";
}

function validateOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("UI origin must be an absolute URL");
  }
  if (
    url.protocol !== "http:" ||
    !isLoopbackHost(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("UI origin must be a loopback HTTP origin without a path");
  }
  return url.origin;
}

function optionalPath(value: string | undefined): string | undefined {
  return value ? expandPath(value) : undefined;
}

function parseBooleanEnvironment(
  name: string,
  value: string | undefined,
): boolean {
  if (value === undefined) return false;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be a boolean`);
  }
}

export function defaultConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    env.XDG_CONFIG_HOME || resolve(homedir(), ".config"),
    "pi-dash",
  );
}

export function loadConfig(
  args: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const cli = parseCli(args);
  const configDir =
    optionalPath(cli["config-dir"] ?? env.PI_DASH_CONFIG_DIR) ??
    defaultConfigDirectory(env);
  const file = readConfigFile(configDir);
  const host = String(pick(cli.host, env.PI_DASH_HOST, file.host, "127.0.0.1"));
  if (!isLoopbackHost(host))
    throw new Error(`Refusing non-loopback bind host: ${host}`);

  const rawLogLevel = String(
    pick(cli["log-level"], env.PI_DASH_LOG_LEVEL, file.logLevel, "info"),
  );
  if (!LOG_LEVELS.includes(rawLogLevel as LogLevel))
    throw new Error(`Invalid log level: ${rawLogLevel}`);

  const nativeDialog = String(
    pick(
      cli["native-dialog"],
      env.PI_DASH_NATIVE_DIALOG,
      file.nativeDialog,
      "auto",
    ),
  );
  if (!["auto", "zenity", "kdialog", "disabled"].includes(nativeDialog)) {
    throw new Error(`Invalid native dialog mode: ${nativeDialog}`);
  }

  const modeValue = env.NODE_ENV;
  const mode =
    modeValue === "test"
      ? "test"
      : modeValue === "development"
        ? "development"
        : "production";
  return {
    host,
    port: parsePort(pick(cli.port, env.PI_DASH_PORT, file.port)),
    dataDir: optionalPath(
      String(pick(cli["data-dir"], env.PI_DASH_DATA_DIR, file.dataDir) ?? ""),
    ),
    configDir,
    runtimeDir: optionalPath(
      String(
        pick(cli["runtime-dir"], env.PI_DASH_RUNTIME_DIR, file.runtimeDir) ??
          "",
      ),
    ),
    piExecutable: String(
      pick(
        cli["pi-executable"],
        env.PI_DASH_PI_EXECUTABLE,
        file.piExecutable,
        "pi",
      ),
    ),
    piMinimumVersion: String(
      pick(
        cli["pi-minimum-version"],
        env.PI_DASH_PI_MINIMUM_VERSION,
        file.piMinimumVersion,
        "0.83.0",
      ),
    ),
    terminalInitialCols: parseInteger(
      "Terminal initial columns",
      pick(
        cli["terminal-initial-cols"],
        env.PI_DASH_TERMINAL_INITIAL_COLS,
        file.terminalInitialCols,
      ),
      100,
      2,
      500,
    ),
    terminalInitialRows: parseInteger(
      "Terminal initial rows",
      pick(
        cli["terminal-initial-rows"],
        env.PI_DASH_TERMINAL_INITIAL_ROWS,
        file.terminalInitialRows,
      ),
      30,
      1,
      300,
    ),
    terminalOutputBufferBytes: parseInteger(
      "Terminal output buffer bytes",
      pick(
        cli["terminal-output-buffer-bytes"],
        env.PI_DASH_TERMINAL_OUTPUT_BUFFER_BYTES,
        file.terminalOutputBufferBytes,
      ),
      4 * 1024 * 1024,
      64 * 1024,
      16 * 1024 * 1024,
    ),
    terminalMaxFrameBytes: parseInteger(
      "Terminal maximum frame bytes",
      pick(
        cli["terminal-max-frame-bytes"],
        env.PI_DASH_TERMINAL_MAX_FRAME_BYTES,
        file.terminalMaxFrameBytes,
      ),
      64 * 1024,
      1024,
      1024 * 1024,
    ),
    terminalMaxSocketBufferedBytes: parseInteger(
      "Terminal maximum socket buffered bytes",
      pick(
        cli["terminal-max-socket-buffered-bytes"],
        env.PI_DASH_TERMINAL_MAX_SOCKET_BUFFERED_BYTES,
        file.terminalMaxSocketBufferedBytes,
      ),
      4 * 1024 * 1024,
      64 * 1024,
      16 * 1024 * 1024,
    ),
    terminalStopGraceMs: parseInteger(
      "Terminal stop grace milliseconds",
      pick(
        cli["terminal-stop-grace-ms"],
        env.PI_DASH_TERMINAL_STOP_GRACE_MS,
        file.terminalStopGraceMs,
      ),
      2_000,
      100,
      30_000,
    ),
    terminalCacheSize: parseInteger(
      "Terminal cache size",
      pick(
        cli["terminal-cache-size"],
        env.PI_DASH_TERMINAL_CACHE_SIZE,
        file.terminalCacheSize,
      ),
      3,
      1,
      12,
    ),
    nativeDialog: nativeDialog as NativeDialogMode,
    logLevel: rawLogLevel as LogLevel,
    uiOrigin: validateOrigin(
      String(
        pick(cli["ui-origin"], env.PI_DASH_UI_ORIGIN, file.uiOrigin) ?? "",
      ),
    ),
    staticDir: optionalPath(
      String(
        pick(cli["static-dir"], env.PI_DASH_STATIC_DIR, file.staticDir) ?? "",
      ),
    ),
    bootstrapOutput: optionalPath(
      String(
        pick(
          cli["bootstrap-output"],
          env.PI_DASH_BOOTSTRAP_OUTPUT,
          file.bootstrapOutput,
        ) ?? "",
      ),
    ),
    desktopControlToken: (() => {
      const token = env.PI_DASH_DESKTOP_CONTROL_TOKEN?.trim() ?? "";
      if (!token) return undefined;
      if (token.length < 32)
        throw new Error(
          "PI_DASH_DESKTOP_CONTROL_TOKEN must be at least 32 characters",
        );
      return token;
    })(),
    openBrowser:
      cli["no-open"] !== "true" &&
      !parseBooleanEnvironment("PI_DASH_NO_OPEN", env.PI_DASH_NO_OPEN),
    mode,
  };
}
