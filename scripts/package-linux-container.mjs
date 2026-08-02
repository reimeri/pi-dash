import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(root, "dist");

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
      `${executable} exited with status ${result.status ?? "unknown"}`,
    );
  }
}

function available(executable) {
  const result = spawnSync(executable, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function containerEngine() {
  const configured = process.env.PI_DASH_CONTAINER_ENGINE?.trim();
  if (configured) return configured;
  for (const candidate of ["podman", "docker"]) {
    if (available(candidate)) return candidate;
  }
  throw new Error(
    "Linux release packaging requires Podman or Docker so native addons are built against the pinned compatibility baseline",
  );
}

function sourceDateEpoch() {
  const configured = process.env.SOURCE_DATE_EPOCH;
  if (configured && /^\d+$/.test(configured)) return configured;
  return execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "The first Pi Dash artifact supports Linux x64 builds only",
    );
  }
  const engine = containerEngine();
  const sourcePackage = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const image = `pi-dash-linux-builder:${sourcePackage.version}`;
  const epoch = sourceDateEpoch();
  run(engine, [
    "build",
    "--platform",
    "linux/amd64",
    "--build-arg",
    `SOURCE_DATE_EPOCH=${epoch}`,
    "--file",
    "packaging/linux/Dockerfile",
    "--tag",
    image,
    ".",
  ]);

  const container = execFileSync(
    engine,
    ["create", "--platform", "linux/amd64", image],
    { cwd: root, encoding: "utf8" },
  ).trim();
  try {
    rmSync(outputRoot, { recursive: true, force: true });
    mkdirSync(outputRoot, { recursive: true });
    run(engine, ["cp", `${container}:/workspace/dist/.`, outputRoot]);
  } finally {
    spawnSync(engine, ["rm", "--force", container], {
      cwd: root,
      stdio: "ignore",
    });
  }
  process.stdout.write(`Linux artifact copied to ${outputRoot}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `Containerized Linux packaging failed: ${error.stack ?? error}\n`,
  );
  process.exitCode = 1;
}
