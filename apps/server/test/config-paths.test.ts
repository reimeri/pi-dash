import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveAppPaths, secureWriteFile } from "../src/paths.js";

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("configuration", () => {
  it("applies CLI over environment over JSON over defaults", () => {
    const root = temporaryRoot();
    const configDirectory = join(root, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, "config.json"),
      JSON.stringify({
        port: 4100,
        piExecutable: "pi-from-file",
        nativeDialog: "kdialog",
        logLevel: "warn",
      }),
    );
    const config = loadConfig(
      [
        "--config-dir",
        configDirectory,
        "--no-open",
        "--port",
        "4300",
        "--pi-executable",
        "pi-from-cli",
        "--native-dialog",
        "auto",
      ],
      {
        PI_DASH_PORT: "4200",
        PI_DASH_NATIVE_DIALOG: "zenity",
        NODE_ENV: "test",
      },
    );
    expect(config.port).toBe(4300);
    expect(config.piExecutable).toBe("pi-from-cli");
    expect(config.terminalOutputBufferBytes).toBe(4 * 1024 * 1024);
    expect(config.logLevel).toBe("warn");
    expect(config.nativeDialog).toBe("auto");
    expect(config.openBrowser).toBe(false);
    expect(config.mode).toBe("test");
  });

  it("supports environment browser-launch suppression", () => {
    const root = temporaryRoot();
    expect(
      loadConfig(["--config-dir", root], { PI_DASH_NO_OPEN: "true" })
        .openBrowser,
    ).toBe(false);
    expect(
      loadConfig(["--config-dir", root], { PI_DASH_NO_OPEN: "false" })
        .openBrowser,
    ).toBe(true);
    expect(() =>
      loadConfig(["--config-dir", root], { PI_DASH_NO_OPEN: "sometimes" }),
    ).toThrow("PI_DASH_NO_OPEN must be a boolean");
  });

  it("rejects unknown and incorrectly typed JSON settings", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ port: "4317", surprise: true }),
    );
    expect(() => loadConfig(["--config-dir", root], {})).toThrow(
      "config port must be a number",
    );
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ surprise: true }),
    );
    expect(() => loadConfig(["--config-dir", root], {})).toThrow(
      "unknown config key",
    );
    writeFileSync(
      join(root, "config.json"),
      JSON.stringify({ nativeDialog: "other" }),
    );
    expect(() => loadConfig(["--config-dir", root], {})).toThrow(
      "config nativeDialog is invalid",
    );
  });

  it("rejects non-loopback binds", () => {
    const root = temporaryRoot();
    expect(() =>
      loadConfig(["--config-dir", root, "--host", "0.0.0.0"], {}),
    ).toThrow("Refusing non-loopback");
  });
});

describe("private paths", () => {
  it("creates canonical private XDG directories and secure files", () => {
    const root = temporaryRoot();
    const config = loadConfig(
      [
        "--config-dir",
        join(root, "config"),
        "--data-dir",
        join(root, "data"),
        "--runtime-dir",
        join(root, "runtime"),
      ],
      { NODE_ENV: "test" },
    );
    const paths = resolveAppPaths(config, {});
    for (const directory of [paths.config, paths.data, paths.runtime]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    const secret = join(paths.runtime, "secret");
    secureWriteFile(secret, "sensitive");
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    expect(readFileSync(secret, "utf8")).toBe("sensitive");
  });
});
