import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDesktopRuntimePaths,
  resolveDesktopRuntimePaths,
} from "./runtime-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("desktop runtime paths", () => {
  it("uses repository resources and the configured Node during development", () => {
    const paths = resolveDesktopRuntimePaths({
      packaged: false,
      resourcesPath: "/ignored",
      moduleUrl: "file:///workspace/pi-dash/apps/desktop/dist/runtime-paths.js",
      env: { PI_DASH_NODE_EXECUTABLE: "/custom/node" },
    });
    expect(paths).toEqual({
      resourceRoot: "/workspace/pi-dash",
      nodeExecutable: "/custom/node",
      serverEntry: "/workspace/pi-dash/apps/server/dist/cli.js",
      staticDirectory: "/workspace/pi-dash/apps/web/dist",
    });
  });

  it("uses the bundled Node and sidecar resources when packaged", () => {
    const paths = resolveDesktopRuntimePaths({
      packaged: true,
      resourcesPath: "/opt/Pi Dash/resources",
      moduleUrl: import.meta.url,
      env: { PI_DASH_NODE_EXECUTABLE: "/untrusted/system/node" },
    });
    expect(paths).toEqual({
      resourceRoot: "/opt/Pi Dash/resources/pi-dash/app",
      nodeExecutable: "/opt/Pi Dash/resources/pi-dash/runtime/bin/node",
      serverEntry: "/opt/Pi Dash/resources/pi-dash/app/apps/server/dist/cli.js",
      staticDirectory: "/opt/Pi Dash/resources/pi-dash/app/apps/web/dist",
    });
  });

  it("accepts a development Node command resolved by spawn through PATH", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-development-runtime-"));
    temporaryDirectories.push(root);
    const serverEntry = join(root, "server.js");
    const staticDirectory = join(root, "web");
    writeFileSync(serverEntry, "");
    mkdirSync(staticDirectory);

    expect(() =>
      assertDesktopRuntimePaths({
        resourceRoot: root,
        nodeExecutable: "node",
        serverEntry,
        staticDirectory,
      }),
    ).not.toThrow();
  });

  it("accepts a Node executable symlink that resolves to a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-symlinked-runtime-"));
    temporaryDirectories.push(root);
    const nodeTarget = join(root, "node-target");
    const nodeExecutable = join(root, "node");
    const serverEntry = join(root, "server.js");
    const staticDirectory = join(root, "web");
    writeFileSync(nodeTarget, "#!/bin/sh\n");
    chmodSync(nodeTarget, 0o755);
    symlinkSync(nodeTarget, nodeExecutable);
    writeFileSync(serverEntry, "");
    mkdirSync(staticDirectory);

    expect(() =>
      assertDesktopRuntimePaths({
        resourceRoot: root,
        nodeExecutable,
        serverEntry,
        staticDirectory,
      }),
    ).not.toThrow();
  });

  it("rejects a Node symlink to a non-executable file", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-non-executable-runtime-"));
    temporaryDirectories.push(root);
    const nodeTarget = join(root, "node-target");
    const nodeExecutable = join(root, "node");
    const serverEntry = join(root, "server.js");
    const staticDirectory = join(root, "web");
    writeFileSync(nodeTarget, "#!/bin/sh\n");
    chmodSync(nodeTarget, 0o644);
    symlinkSync(nodeTarget, nodeExecutable);
    writeFileSync(serverEntry, "");
    mkdirSync(staticDirectory);

    expect(() =>
      assertDesktopRuntimePaths({
        resourceRoot: root,
        nodeExecutable,
        serverEntry,
        staticDirectory,
      }),
    ).toThrow();
  });

  it("rejects a Node symlink that resolves to a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dash-directory-runtime-"));
    temporaryDirectories.push(root);
    const nodeTarget = join(root, "node-target");
    const nodeExecutable = join(root, "node");
    const serverEntry = join(root, "server.js");
    const staticDirectory = join(root, "web");
    mkdirSync(nodeTarget);
    symlinkSync(nodeTarget, nodeExecutable);
    writeFileSync(serverEntry, "");
    mkdirSync(staticDirectory);

    expect(() =>
      assertDesktopRuntimePaths({
        resourceRoot: root,
        nodeExecutable,
        serverEntry,
        staticDirectory,
      }),
    ).toThrow("Node executable must resolve to a regular file");
  });

  it("validates required runtime files and executable permissions", () => {
    const resourcesPath = mkdtempSync(join(tmpdir(), "pi-dash-runtime-"));
    temporaryDirectories.push(resourcesPath);
    const paths = resolveDesktopRuntimePaths({
      packaged: true,
      resourcesPath,
      moduleUrl: import.meta.url,
    });
    mkdirSync(dirname(paths.nodeExecutable), { recursive: true });
    mkdirSync(join(paths.resourceRoot, "apps/server/dist"), {
      recursive: true,
    });
    mkdirSync(paths.staticDirectory, { recursive: true });
    writeFileSync(paths.nodeExecutable, "#!/bin/sh\n");
    chmodSync(paths.nodeExecutable, 0o755);
    writeFileSync(paths.serverEntry, "");

    expect(() => assertDesktopRuntimePaths(paths)).not.toThrow();
  });
});
