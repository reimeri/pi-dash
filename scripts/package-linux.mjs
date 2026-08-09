import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(root, ".release");
const sidecarRoot = join(releaseRoot, "pi-dash");
const applicationRoot = join(sidecarRoot, "app");
const electronAppRoot = join(releaseRoot, "electron-app");
const outputRoot = join(root, "dist");
const nodeVersion = "24.18.0";
const nodeArchiveName = `node-v${nodeVersion}-linux-x64.tar.xz`;
const nodeArchiveSha256 =
  "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742";
const nodeDownloadUrl = `https://nodejs.org/download/release/v${nodeVersion}/${nodeArchiveName}`;
const maximumGlibcVersion = "2.31";
const maximumGlibcxxVersion = "3.4.28";
const cacheRoot = resolve(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "pi-dash-packaging",
);
const cachedNodeArchive = join(cacheRoot, nodeArchiveName);

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${basename(executable)} exited with status ${result.status ?? "unknown"}`,
    );
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function ensureNodeArchive() {
  mkdirSync(cacheRoot, { recursive: true });
  if (existsSync(cachedNodeArchive)) {
    if ((await sha256(cachedNodeArchive)) === nodeArchiveSha256) {
      return cachedNodeArchive;
    }
    unlinkSync(cachedNodeArchive);
  }

  process.stdout.write(`Downloading ${nodeDownloadUrl}\n`);
  const response = await fetch(nodeDownloadUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `Unable to download Node.js ${nodeVersion}: HTTP ${response.status}`,
    );
  }
  const finalUrl = new URL(response.url);
  if (
    finalUrl.protocol !== "https:" ||
    finalUrl.hostname !== "nodejs.org" ||
    finalUrl.pathname !== `/download/release/v${nodeVersion}/${nodeArchiveName}`
  ) {
    throw new Error(
      `Node.js download redirected to an unapproved URL: ${response.url}`,
    );
  }
  const temporary = `${cachedNodeArchive}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { mode: 0o600 }),
    );
    const digest = await sha256(temporary);
    if (digest !== nodeArchiveSha256) {
      throw new Error(
        `Node.js archive checksum mismatch: expected ${nodeArchiveSha256}, received ${digest}`,
      );
    }
    renameSync(temporary, cachedNodeArchive);
  } finally {
    rmSync(temporary, { force: true });
  }
  return cachedNodeArchive;
}

function copyRuntimeJavaScript(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    filter(path) {
      const name = basename(path);
      return (
        !name.endsWith(".d.ts") &&
        !name.endsWith(".d.ts.map") &&
        !name.endsWith(".js.map") &&
        !name.endsWith(".test.js") &&
        name !== ".tsbuildinfo"
      );
    },
  });
}

function prepareNativeSourceBuild() {
  const modules = join(applicationRoot, "node_modules");
  for (const path of [
    join(modules, "better-sqlite3", "prebuilds"),
    join(modules, "better-sqlite3", "build"),
    join(modules, "fs-ext", "build"),
    join(modules, "node-pty", "prebuilds"),
    join(modules, "node-pty", "build"),
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
}

function pruneTargetIncompatibleNativeFiles() {
  const modules = join(applicationRoot, "node_modules");
  rmSync(join(modules, "node-pty", "prebuilds"), {
    recursive: true,
    force: true,
  });
  rmSync(join(modules, "node-pty", "third_party"), {
    recursive: true,
    force: true,
  });
  rmSync(join(modules, "node-pty", "build", "Release", "obj.target"), {
    recursive: true,
    force: true,
  });
  rmSync(join(modules, "better-sqlite3", "prebuilds"), {
    recursive: true,
    force: true,
  });
  rmSync(join(modules, "better-sqlite3", "build", "Release", "obj.target"), {
    recursive: true,
    force: true,
  });
  rmSync(join(modules, "better-sqlite3", "deps"), {
    recursive: true,
    force: true,
  });
  rmSync(join(modules, "better-sqlite3", "src"), {
    recursive: true,
    force: true,
  });
  rmSync(join(modules, "fs-ext", "build", "Release", "obj.target"), {
    recursive: true,
    force: true,
  });
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

function verifyNativeCompatibility() {
  const modules = join(applicationRoot, "node_modules");
  const nativeFiles = [
    join(modules, "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    join(modules, "fs-ext", "build", "Release", "fs_ext.node"),
    join(modules, "node-pty", "build", "Release", "pty.node"),
  ];
  const results = [];
  for (const file of nativeFiles) {
    const symbols = execFileSync("objdump", ["-T", file], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const glibc = maximumSymbolVersion(symbols, "GLIBC");
    const glibcxx = maximumSymbolVersion(symbols, "GLIBCXX");
    if (glibc && compareVersion(glibc, maximumGlibcVersion) > 0) {
      throw new Error(
        `${basename(file)} requires GLIBC_${glibc}; maximum allowed is GLIBC_${maximumGlibcVersion}`,
      );
    }
    if (glibcxx && compareVersion(glibcxx, maximumGlibcxxVersion) > 0) {
      throw new Error(
        `${basename(file)} requires GLIBCXX_${glibcxx}; maximum allowed is GLIBCXX_${maximumGlibcxxVersion}`,
      );
    }
    results.push(
      `${file.slice(applicationRoot.length + 1)} GLIBC_${glibc ?? "none"} GLIBCXX_${glibcxx ?? "none"}`,
    );
  }
  writeFileSync(
    join(sidecarRoot, "runtime", "NATIVE-COMPATIBILITY"),
    `Maximum allowed: GLIBC_${maximumGlibcVersion} GLIBCXX_${maximumGlibcxxVersion}\n${results.join("\n")}\n`,
  );
}

function stageSidecar(nodeDistribution) {
  mkdirSync(applicationRoot, { recursive: true });
  copyFileSync(
    join(root, "package.json"),
    join(applicationRoot, "package.json"),
  );
  copyFileSync(
    join(root, "package-lock.json"),
    join(applicationRoot, "package-lock.json"),
  );
  copyFileSync(join(root, "README.md"), join(applicationRoot, "README.md"));

  for (const workspace of [
    "apps/server",
    "packages/contracts",
    "packages/pi-extension",
  ]) {
    const destination = join(applicationRoot, workspace);
    mkdirSync(destination, { recursive: true });
    copyFileSync(
      join(root, workspace, "package.json"),
      join(destination, "package.json"),
    );
    copyRuntimeJavaScript(
      join(root, workspace, "dist"),
      join(destination, "dist"),
    );
  }
  cpSync(join(root, "apps/web/dist"), join(applicationRoot, "apps/web/dist"), {
    recursive: true,
  });
  cpSync(join(root, "migrations"), join(applicationRoot, "migrations"), {
    recursive: true,
  });

  const runtimeBin = join(sidecarRoot, "runtime", "bin");
  const licenses = join(sidecarRoot, "licenses");
  mkdirSync(runtimeBin, { recursive: true });
  mkdirSync(licenses, { recursive: true });
  copyFileSync(join(nodeDistribution, "bin/node"), join(runtimeBin, "node"));
  chmodSync(join(runtimeBin, "node"), 0o755);
  copyFileSync(join(root, "LICENSE"), join(licenses, "pi-dash-LICENSE"));
  copyFileSync(
    join(nodeDistribution, "LICENSE"),
    join(licenses, `node-v${nodeVersion}-LICENSE`),
  );
  writeFileSync(
    join(sidecarRoot, "runtime", "VERSION"),
    `Node.js ${nodeVersion}\n${nodeArchiveName}\nSHA-256 ${nodeArchiveSha256}\n`,
  );

  const distributionNode = join(nodeDistribution, "bin", "node");
  const npmCli = join(
    nodeDistribution,
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  run(
    distributionNode,
    [
      npmCli,
      "ci",
      "--omit=dev",
      "--workspace",
      "@pi-dash/server",
      "--include-workspace-root=false",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: applicationRoot,
      env: {
        ...process.env,
        PATH: `${join(nodeDistribution, "bin")}:${process.env.PATH ?? ""}`,
        npm_config_nodedir: nodeDistribution,
      },
    },
  );

  prepareNativeSourceBuild();
  run(
    distributionNode,
    [npmCli, "rebuild", "fs-ext", "node-pty", "--no-audit", "--no-fund"],
    {
      cwd: applicationRoot,
      env: {
        ...process.env,
        PATH: `${join(nodeDistribution, "bin")}:${process.env.PATH ?? ""}`,
        npm_config_nodedir: nodeDistribution,
      },
    },
  );
  run(
    distributionNode,
    [
      npmCli,
      "run",
      "build-release",
      "--prefix",
      join(applicationRoot, "node_modules", "better-sqlite3"),
    ],
    {
      cwd: applicationRoot,
      env: {
        ...process.env,
        PATH: `${join(nodeDistribution, "bin")}:${process.env.PATH ?? ""}`,
        npm_config_nodedir: nodeDistribution,
      },
    },
  );
  pruneTargetIncompatibleNativeFiles();
  verifyNativeCompatibility();

  const bundledNode = join(sidecarRoot, "runtime", "bin", "node");
  run(
    bundledNode,
    [
      "--input-type=module",
      "--eval",
      [
        `if (process.version !== "v${nodeVersion}") throw new Error("Unexpected bundled Node " + process.version);`,
        `await import("better-sqlite3");`,
        `await import("fs-ext");`,
        `await import("node-pty");`,
        `process.stdout.write("Bundled Node/native addon smoke test passed\\n");`,
      ].join("\n"),
    ],
    { cwd: applicationRoot },
  );
}

function stageElectronApplication() {
  mkdirSync(join(electronAppRoot, "dist"), { recursive: true });
  copyRuntimeJavaScript(
    join(root, "apps/desktop/dist"),
    join(electronAppRoot, "dist"),
  );
  const sourcePackage = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  writeFileSync(
    join(electronAppRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "pi-dash-desktop",
        productName: "Pi Dash",
        version: sourcePackage.version,
        private: true,
        type: "module",
        main: "dist/main.js",
        description: "Linux-first local dashboard for Pi",
        author: "OxyAI",
        license: "MIT",
        homepage: "https://github.com/reimeri/pi-dash",
      },
      null,
      2,
    )}\n`,
  );
}

function normalizeTimestamps(path, timestamp) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path)) {
      normalizeTimestamps(join(path, entry), timestamp);
    }
  }
  utimesSync(path, timestamp, timestamp);
}

function sourceDateEpoch() {
  const configured = process.env.SOURCE_DATE_EPOCH;
  if (configured && /^\d+$/.test(configured)) return Number(configured);
  return Number(
    execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  );
}

async function writeChecksums() {
  const artifacts = readdirSync(outputRoot)
    .filter((name) => name.endsWith(".tar.gz"))
    .sort();
  if (artifacts.length !== 1) {
    throw new Error(
      `electron-builder must produce exactly one tar.gz artifact, received ${artifacts.length}`,
    );
  }
  const lines = [];
  for (const artifact of artifacts) {
    lines.push(`${await sha256(join(outputRoot, artifact))}  ${artifact}`);
  }
  const checksumPath = join(outputRoot, "SHA256SUMS");
  const temporary = `${checksumPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${lines.join("\n")}\n`);
  renameSync(temporary, checksumPath);
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "The first Pi Dash artifact supports Linux x64 builds only",
    );
  }
  rmSync(releaseRoot, { recursive: true, force: true });
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(releaseRoot, { recursive: true });
  mkdirSync(outputRoot, { recursive: true });

  const archive = await ensureNodeArchive();
  run("tar", [
    "--extract",
    "--xz",
    "--file",
    archive,
    "--directory",
    releaseRoot,
    "--no-same-owner",
  ]);
  const nodeDistribution = join(releaseRoot, `node-v${nodeVersion}-linux-x64`);
  stageSidecar(nodeDistribution);
  stageElectronApplication();

  const epoch = sourceDateEpoch();
  const timestamp = new Date(epoch * 1_000);
  normalizeTimestamps(sidecarRoot, timestamp);
  normalizeTimestamps(electronAppRoot, timestamp);

  run(
    join(root, "node_modules", ".bin", "electron-builder"),
    [
      "--projectDir",
      electronAppRoot,
      "--config",
      join(root, "packaging/linux/electron-builder.yml"),
      "--linux",
      "tar.gz",
      "--x64",
      "--publish",
      "never",
    ],
    {
      env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
    },
  );
  await writeChecksums();
  process.stdout.write(`Linux artifact written to ${outputRoot}\n`);
}

main().catch((error) => {
  process.stderr.write(`Linux packaging failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});
