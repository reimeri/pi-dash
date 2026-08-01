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
  nativeDialog: NativeDialogMode;
  logLevel: LogLevel;
  uiOrigin?: string;
  staticDir?: string;
  bootstrapOutput?: string;
  mode: "development" | "production" | "test";
}

interface ConfigFile {
  host?: string;
  port?: number;
  dataDir?: string;
  runtimeDir?: string;
  piExecutable?: string;
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
  "native-dialog",
  "log-level",
  "ui-origin",
  "static-dir",
  "bootstrap-output",
]);

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
      if (key === "port") {
        if (typeof value !== "number")
          throw new Error("config port must be a number");
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

function parsePort(value: string | number | undefined): number {
  const port = typeof value === "number" ? value : Number(value ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("Port must be an integer from 1 to 65535");
  return port;
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
    mode,
  };
}
