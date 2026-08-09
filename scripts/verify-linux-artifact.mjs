import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";
import { extract, list } from "tar";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "dist");
const maximumGlibcVersion = "2.31";
const maximumGlibcxxVersion = "3.4.28";
const requiredFiles = [
  "pi-dash",
  "resources/app.asar",
  "resources/pi-dash/runtime/bin/node",
  "resources/pi-dash/runtime/VERSION",
  "resources/pi-dash/runtime/NATIVE-COMPATIBILITY",
  "resources/pi-dash/licenses/node-v24.18.0-LICENSE",
  "resources/pi-dash/licenses/pi-dash-LICENSE",
  "resources/pi-dash/app/apps/server/dist/cli.js",
  "resources/pi-dash/app/apps/web/dist/index.html",
  "resources/pi-dash/app/migrations/0001_foundation.sql",
  "resources/pi-dash/app/packages/pi-extension/dist/runtime.js",
  "resources/pi-dash/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  "resources/pi-dash/app/node_modules/fs-ext/build/Release/fs_ext.node",
  "resources/pi-dash/app/node_modules/node-pty/build/Release/pty.node",
];

function fail(message) {
  throw new Error(message);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function selectArtifact(argument) {
  if (argument) return resolve(argument);
  const matches = readdirSync(outputRoot)
    .filter((name) => /^pi-dash-\d+\.\d+\.\d+-linux-x64\.tar\.gz$/.test(name))
    .map((name) => join(outputRoot, name));
  if (matches.length !== 1) {
    fail("Pass one Linux tar.gz artifact path to verify");
  }
  return matches[0];
}

async function verifyChecksum(artifact) {
  const checksumPath = join(dirname(artifact), "SHA256SUMS");
  const expected = readFileSync(checksumPath, "utf8")
    .split("\n")
    .map((line) => line.match(/^([0-9a-f]{64}) {2}(.+)$/))
    .find((match) => match?.[2] === basename(artifact))?.[1];
  if (!expected) fail(`SHA256SUMS has no entry for ${basename(artifact)}`);
  const actual = await sha256(artifact);
  if (actual !== expected) {
    fail(
      `Artifact checksum mismatch: expected ${expected}, received ${actual}`,
    );
  }
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `${basename(executable)} exited with status ${result.status ?? "unknown"}`,
    );
  }
}

function compareVersion(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function maximumSymbolVersion(contents, prefix) {
  const versions = [
    ...contents.matchAll(new RegExp(`${prefix}_([0-9]+(?:\\.[0-9]+)+)`, "g")),
  ].map((match) => match[1]);
  return versions.sort(compareVersion).at(-1);
}

async function inspectEntries(artifact) {
  const expectedTopLevel = basename(artifact, ".tar.gz");
  const entries = [];
  await list({
    file: artifact,
    strict: true,
    onReadEntry(entry) {
      entries.push({
        rawPath: entry.path,
        path: entry.path.replace(/\/$/, ""),
        type: entry.type,
        linkpath: entry.linkpath,
        mode: entry.mode,
      });
      entry.resume();
    },
  });

  const seen = new Set();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    if (
      entry.rawPath.endsWith("//") ||
      entry.rawPath.includes("//") ||
      posix.normalize(entry.path) !== entry.path ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
      entry.path.startsWith("/") ||
      (entry.path !== expectedTopLevel &&
        !entry.path.startsWith(`${expectedTopLevel}/`))
    ) {
      fail(
        `Unsafe, noncanonical, or unexpected archive entry: ${entry.rawPath}`,
      );
    }
    if (seen.has(entry.path)) fail(`Duplicate archive entry: ${entry.path}`);
    seen.add(entry.path);
    if (!["File", "Directory", "SymbolicLink"].includes(entry.type)) {
      fail(`Unsupported archive entry type ${entry.type}: ${entry.path}`);
    }
    if (entry.type === "SymbolicLink") {
      if (!entry.linkpath || posix.isAbsolute(entry.linkpath)) {
        fail(`Unsafe archive link: ${entry.path}`);
      }
      const target = posix.resolve(
        "/",
        posix.dirname(entry.path),
        entry.linkpath,
      );
      if (
        target !== `/${expectedTopLevel}` &&
        !target.startsWith(`/${expectedTopLevel}/`)
      ) {
        fail(`Archive link escapes the application tree: ${entry.path}`);
      }
    }
  }

  for (const relative of requiredFiles) {
    const path = `${expectedTopLevel}/${relative}`;
    const entry = entries.find((candidate) => candidate.path === path);
    if (!entry || entry.type !== "File")
      fail(`Artifact is missing ${relative}`);
  }
  for (const relative of ["pi-dash", "resources/pi-dash/runtime/bin/node"]) {
    const entry = entries.find(
      (candidate) => candidate.path === `${expectedTopLevel}/${relative}`,
    );
    if (!entry?.mode || (entry.mode & 0o111) === 0) {
      fail(`Artifact executable has no execute mode: ${relative}`);
    }
  }

  const forbidden = [
    /(?:^|\/)\.env(?:\.|$)/,
    /(?:^|\/)\.pi-dash-data(?:\/|$)/,
    /(?:^|\/)(?:test-results|playwright-report)(?:\/|$)/,
    /(?:^|\/)bootstrap-url$/,
    /(?:^|\/)daemon(?:\.\d+)?\.log$/,
    /\.sqlite(?:-shm|-wal)?$/,
    /resources\/pi-dash\/app\/(?:apps|packages)\/.*(?:\.d\.ts|\.map|\.test\.js)$/,
  ];
  for (const entry of entries) {
    if (forbidden.some((pattern) => pattern.test(entry.path))) {
      fail(`Forbidden release content: ${entry.path}`);
    }
  }
  return expectedTopLevel;
}

function verifyNativeBinary(path) {
  const header = execFileSync("readelf", ["-h", path], { encoding: "utf8" });
  if (
    !/Class:\s+ELF64/.test(header) ||
    !/Machine:\s+Advanced Micro Devices X86-64/.test(header)
  ) {
    fail(`Native binary is not Linux x64 ELF: ${path}`);
  }
  const symbols = execFileSync("objdump", ["-T", path], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const glibc = maximumSymbolVersion(symbols, "GLIBC");
  const glibcxx = maximumSymbolVersion(symbols, "GLIBCXX");
  if (glibc && compareVersion(glibc, maximumGlibcVersion) > 0) {
    fail(`${basename(path)} requires unsupported GLIBC_${glibc}`);
  }
  if (glibcxx && compareVersion(glibcxx, maximumGlibcxxVersion) > 0) {
    fail(`${basename(path)} requires unsupported GLIBCXX_${glibcxx}`);
  }
}

function isElf(path) {
  const descriptor = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    return (
      readSync(descriptor, magic, 0, magic.length, 0) === magic.length &&
      magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    );
  } finally {
    closeSync(descriptor);
  }
}

function auditExtractedElfs(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path)) {
      auditExtractedElfs(join(path, entry));
    }
  } else if (metadata.isFile() && isElf(path)) {
    verifyNativeBinary(path);
  }
}

function verifyExtractedLayout(extractionRoot, topLevel) {
  const applicationRoot = join(extractionRoot, topLevel);
  for (const relative of requiredFiles) {
    const metadata = lstatSync(join(applicationRoot, relative));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`Extracted required file is not regular: ${relative}`);
    }
  }
  for (const relative of ["pi-dash", "resources/pi-dash/runtime/bin/node"]) {
    if ((lstatSync(join(applicationRoot, relative)).mode & 0o111) === 0) {
      fail(`Extracted executable has no execute mode: ${relative}`);
    }
  }
  auditExtractedElfs(applicationRoot);
}

function verifyElectronMetadata(applicationRoot) {
  const sourceMetadata = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const metadata = JSON.parse(
    extractFile(
      join(applicationRoot, "resources", "app.asar"),
      "package.json",
    ).toString("utf8"),
  );
  if (metadata.name !== "pi-dash-desktop") {
    fail("Electron application has an unexpected package name");
  }
  if (metadata.version !== sourceMetadata.version) {
    fail(
      `Electron application version mismatch: expected ${sourceMetadata.version}, received ${metadata.version}`,
    );
  }
  if (metadata.license !== "MIT") {
    fail("Electron application must be marked MIT");
  }
}

function verifyFirstPartyMetadata(applicationRoot) {
  for (const relative of [
    "package.json",
    "apps/server/package.json",
    "packages/contracts/package.json",
    "packages/pi-extension/package.json",
  ]) {
    const metadata = JSON.parse(
      readFileSync(join(applicationRoot, relative), "utf8"),
    );
    if (metadata.license !== "MIT") {
      fail(`First-party package must be marked MIT: ${relative}`);
    }
  }
}

function verifyProjectLicense(sidecarRoot) {
  const expected = readFileSync(join(root, "LICENSE"), "utf8");
  const actual = readFileSync(
    join(sidecarRoot, "licenses", "pi-dash-LICENSE"),
    "utf8",
  );
  if (actual !== expected) {
    fail("Packaged Pi Dash license does not match the project LICENSE");
  }
  if (!actual.includes("Copyright (c) 2026 OxyAI")) {
    fail("Packaged Pi Dash license has an unexpected copyright notice");
  }
}

function scanFirstPartyContents(sidecarRoot) {
  const roots = [
    join(sidecarRoot, "app", "apps"),
    join(sidecarRoot, "app", "packages"),
    join(sidecarRoot, "app", "migrations"),
    join(sidecarRoot, "app", "package.json"),
    join(sidecarRoot, "app", "README.md"),
    join(sidecarRoot, "runtime"),
  ];
  const secretPatterns = [
    /\b(?:sk-ant-|sk-proj-|ghp_)[A-Za-z0-9_-]{16,}/,
    /(?:authorization|token)["'\s:=]+(?:bearer\s+)?[A-Za-z0-9_-]{32,}/i,
    /\/home\/[^/\0]+\/(?:\.pi|\.config|\.local\/share)\//,
  ];
  const scan = (path) => {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) return;
    if (metadata.isDirectory()) {
      if (basename(path) === "node_modules") return;
      for (const entry of readdirSync(path)) scan(join(path, entry));
      return;
    }
    if (!metadata.isFile() || metadata.size > 5 * 1024 * 1024) return;
    const contents = readFileSync(path, "utf8");
    if (secretPatterns.some((pattern) => pattern.test(contents))) {
      fail(`Possible credential or local user path in release file: ${path}`);
    }
  };
  for (const path of roots) scan(path);
}

function smokeTest(extractionRoot, topLevel) {
  const sidecarRoot = join(extractionRoot, topLevel, "resources", "pi-dash");
  const applicationRoot = join(sidecarRoot, "app");
  const node = join(sidecarRoot, "runtime", "bin", "node");
  const databasePath = join(extractionRoot, "smoke.sqlite");
  const lockPath = join(extractionRoot, "smoke.lock");
  const databaseModule = join(
    applicationRoot,
    "apps",
    "server",
    "dist",
    "database.js",
  );
  const migrations = join(applicationRoot, "migrations");
  verifyElectronMetadata(join(extractionRoot, topLevel));
  verifyFirstPartyMetadata(applicationRoot);
  verifyProjectLicense(sidecarRoot);
  scanFirstPartyContents(sidecarRoot);

  const script = [
    `if (process.version !== "v24.18.0") throw new Error("Unexpected Node version " + process.version);`,
    `const { default: fs } = await import("node:fs");`,
    `const { createRequire } = await import("node:module");`,
    `const require = createRequire(${JSON.stringify(join(applicationRoot, "package.json"))});`,
    `const fsExt = require("fs-ext");`,
    `const pty = require("node-pty");`,
    `const descriptor = fs.openSync(${JSON.stringify(lockPath)}, "w");`,
    `fsExt.flockSync(descriptor, "exnb");`,
    `fsExt.flockSync(descriptor, "un");`,
    `fs.closeSync(descriptor);`,
    `await new Promise((resolve, reject) => {`,
    `  let output = "";`,
    `  const terminal = pty.spawn("/bin/sh", ["-c", "printf PI_DASH_PTY_SMOKE"], { cols: 80, rows: 24 });`,
    `  terminal.onData((data) => { output += data; });`,
    `  terminal.onExit(({ exitCode }) => output.includes("PI_DASH_PTY_SMOKE") && exitCode === 0 ? resolve() : reject(new Error("PTY smoke failed")));`,
    `});`,
    `const { pathToFileURL } = await import("node:url");`,
    `const { openDatabase } = await import(pathToFileURL(${JSON.stringify(databaseModule)}).href);`,
    `const database = await openDatabase({ path: ${JSON.stringify(databasePath)}, migrationsDirectory: ${JSON.stringify(migrations)} });`,
    `if (database.schemaVersion < 1) throw new Error("Migrations did not run");`,
    `database.close();`,
    `process.stdout.write("Extracted runtime smoke test passed\\n");`,
  ].join("\n");
  const unrelatedCwd = join(extractionRoot, "unrelated cwd");
  mkdirSync(unrelatedCwd);
  run(node, ["--input-type=module", "--eval", script], {
    cwd: unrelatedCwd,
  });
}

async function main() {
  const artifact = selectArtifact(process.argv[2]);
  await verifyChecksum(artifact);
  const topLevel = await inspectEntries(artifact);
  const extractionRoot = mkdtempSync(join(tmpdir(), "Pi Dash π artifact-"));
  try {
    await extract({
      file: artifact,
      cwd: extractionRoot,
      strict: true,
      preservePaths: false,
    });
    verifyExtractedLayout(extractionRoot, topLevel);
    smokeTest(extractionRoot, topLevel);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
  process.stdout.write(`Verified ${artifact}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `Artifact verification failed: ${error.stack ?? error}\n`,
  );
  process.exitCode = 1;
});
