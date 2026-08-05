import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const workspacePackagePaths = [
  "package.json",
  "apps/web/package.json",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
  "packages/pi-extension/package.json",
];

const appVersionPath = join(root, "packages/contracts/src/index.ts");
const versionArgumentPattern = /^(major|minor|patch|\d+\.\d+\.\d+)$/;
const appVersionPattern =
  /^export const APP_VERSION = "\d+\.\d+\.\d+";$/m;

function usage() {
  return "Usage: node scripts/bump-version.mjs <major|minor|patch|x.y.z>";
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid version: ${value}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

function bumpVersion(current, kind) {
  const version = parseVersion(current);
  if (kind === "major") {
    return formatVersion({ major: version.major + 1, minor: 0, patch: 0 });
  }
  if (kind === "minor") {
    return formatVersion({
      major: version.major,
      minor: version.minor + 1,
      patch: 0,
    });
  }
  if (kind === "patch") {
    return formatVersion({
      major: version.major,
      minor: version.minor,
      patch: version.patch + 1,
    });
  }
  return formatVersion(parseVersion(kind));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function setPackageVersion(relativePath, version) {
  const path = join(root, relativePath);
  const packageJson = readJson(path);
  packageJson.version = version;
  writeJson(path, packageJson);
}

function setAppVersion(version) {
  const source = readFileSync(appVersionPath, "utf8");
  if (!appVersionPattern.test(source)) {
    throw new Error(
      `Could not find APP_VERSION export in ${appVersionPath}`,
    );
  }
  writeFileSync(
    appVersionPath,
    source.replace(
      appVersionPattern,
      `export const APP_VERSION = "${version}";`,
    ),
  );
}

function refreshLockfile() {
  const result = spawnSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts"],
    {
      cwd: root,
      stdio: "inherit",
      shell: false,
    },
  );
  if (result.status !== 0) {
    throw new Error("Failed to refresh package-lock.json");
  }
}

function main() {
  const kind = process.argv[2];
  if (!kind || !versionArgumentPattern.test(kind)) {
    console.error(usage());
    process.exit(1);
  }

  const rootPackagePath = join(root, "package.json");
  const current = readJson(rootPackagePath).version;
  const next = bumpVersion(current, kind);

  for (const relativePath of workspacePackagePaths) {
    setPackageVersion(relativePath, next);
  }
  setAppVersion(next);
  refreshLockfile();

  console.log(`Bumped version ${current} -> ${next}`);
}

main();
