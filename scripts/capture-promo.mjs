import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDirectory = "dist/promo";
const terminalFilename = "pi-dash-app-terminal.png";
const diffFilename = "pi-dash-app-diff.png";
const viewport = { width: 1440, height: 960 };
const deviceScaleFactor = 2;

function usage() {
  return [
    "Usage: npm run capture:promo -- [--output-dir <path>]",
    "",
    `Default output directory: ${defaultOutputDirectory}`,
    `Output files: ${terminalFilename}, ${diffFilename}`,
    "Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to use a specific Chromium binary.",
  ].join("\n");
}

function parseArguments(args) {
  let outputDirectory = defaultOutputDirectory;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--output-dir") {
      const value = args[index + 1];
      if (!value) throw new Error("--output-dir requires a path");
      outputDirectory = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output-dir=")) {
      outputDirectory = argument.slice("--output-dir=".length);
      if (!outputDirectory) throw new Error("--output-dir requires a path");
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }
  const resolvedDirectory = isAbsolute(outputDirectory)
    ? outputDirectory
    : resolve(projectRoot, outputDirectory);
  return {
    outputDirectory: resolvedDirectory,
    terminalOutput: join(resolvedDirectory, terminalFilename),
    diffOutput: join(resolvedDirectory, diffFilename),
  };
}

function findChromiumExecutable() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ]) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching the executable path.
      }
    }
  }
  return undefined;
}

function createRepository(parent, directoryName, files) {
  const repository = join(parent, directoryName);
  const templateDirectory = join(parent, ".git-template");
  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  mkdirSync(templateDirectory, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(repository, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  execFileSync(
    "git",
    [
      "init",
      "--initial-branch=main",
      `--template=${templateDirectory}`,
      repository,
    ],
    { env: gitEnvironment, stdio: "ignore" },
  );
  execFileSync("git", ["config", "user.name", "Pi Dash"], {
    cwd: repository,
    env: gitEnvironment,
  });
  execFileSync("git", ["config", "user.email", "demo@pi-dash.local"], {
    cwd: repository,
    env: gitEnvironment,
  });
  execFileSync("git", ["add", "--", "."], {
    cwd: repository,
    env: gitEnvironment,
  });
  execFileSync(
    "git",
    ["-c", "commit.gpgSign=false", "commit", "-m", "Initial project setup"],
    { cwd: repository, env: gitEnvironment, stdio: "ignore" },
  );
  return repository;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  if (!port) throw new Error("Unable to reserve a local port");
  return port;
}

function redactSensitiveText(value) {
  return value
    .replace(
      /http:\/\/\S+\/auth\/bootstrap(?:\?\S+)?/gi,
      "[launch URL redacted]",
    )
    .replace(/([?&]token=)[^&\s)\]}]+/gi, "$1[redacted]")
    .replace(/(token["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[redacted]");
}

function redactDaemonOutput(value) {
  return redactSensitiveText(value).slice(-8_000);
}

async function waitForDaemon(daemon, outputFile, port, daemonOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(
        `Pi Dash daemon exited with code ${daemon.exitCode}.\n${redactDaemonOutput(daemonOutput())}`,
      );
    }
    try {
      const bootstrapUrl = (await readFile(outputFile, "utf8")).trim();
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (bootstrapUrl && response.ok) return bootstrapUrl;
    } catch {
      // The daemon is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `Timed out waiting for the Pi Dash daemon.\n${redactDaemonOutput(daemonOutput())}`,
  );
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), 5_000),
    ),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

async function stageData(page, piDashRepository, docsRepository) {
  return page.evaluate(
    async ({ piDashRepository: piDashPath, docsRepository: docsPath }) => {
      const sessionResponse = await fetch("/api/v1/session");
      if (!sessionResponse.ok) throw new Error("Unable to load the session");
      const session = await sessionResponse.json();

      async function request(path, options = {}) {
        const response = await fetch(path, {
          method: options.method ?? "GET",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            ...(options.method && options.method !== "GET"
              ? {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": session.csrfToken,
                  ...(options.idempotencyKey
                    ? { "Idempotency-Key": options.idempotencyKey }
                    : {}),
                }
              : {}),
          },
          ...(options.method && options.method !== "GET"
            ? { body: JSON.stringify(options.body ?? {}) }
            : {}),
        });
        const body = await response.json().catch(() => undefined);
        if (!response.ok) {
          throw new Error(
            `${options.method ?? "GET"} ${path} failed (${response.status}): ${body?.error?.message ?? "unknown error"}`,
          );
        }
        return body;
      }

      async function createWorkspace(path, name) {
        const response = await request("/api/v1/workspaces", {
          method: "POST",
          body: { path, name },
        });
        return response.workspace;
      }

      async function createWorktree(workspace, name, slug) {
        const refs = await request(
          `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/refs?limit=50`,
        );
        const base = refs.head ?? refs.refs[0];
        if (!base) throw new Error(`${workspace.name} has no usable base ref`);
        const response = await request(
          `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/worktrees`,
          {
            method: "POST",
            idempotencyKey: crypto.randomUUID(),
            body: {
              name,
              slug,
              baseRef: base.fullName,
              baseCommit: base.commit,
              baseSnapshotToken: base.baseSnapshotToken,
            },
          },
        );
        return response.worktree;
      }

      const piDash = await createWorkspace(piDashPath, "Pi Dash");
      const docs = await createWorkspace(docsPath, "Documentation");
      const terminalPolish = await createWorktree(
        piDash,
        "Terminal polish",
        "terminal-polish",
      );
      const workflowStatus = await createWorktree(
        piDash,
        "Workflow status",
        "workflow-status",
      );
      const captureTooling = await createWorktree(
        piDash,
        "Capture tooling",
        "capture-tooling",
      );
      const installationGuide = await createWorktree(
        docs,
        "Installation guide",
        "installation-guide",
      );
      return {
        terminalPolish,
        workflowStatus,
        captureTooling,
        installationGuide,
      };
    },
    { piDashRepository, docsRepository },
  );
}

function addDemoChanges(worktrees) {
  writeFileSync(
    join(worktrees.captureTooling.path, "src/capture.ts"),
    `export const captureOptions = {
  viewport: { width: 1440, height: 960 },
  deviceScaleFactor: 2,
  animations: false,
};

export async function waitForStableFrame(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.getByTestId("dashboard-shell").waitFor();
}
`,
  );
  writeFileSync(
    join(worktrees.captureTooling.path, "src/capture.test.ts"),
    `import { captureOptions } from "./capture";

it("captures a high-resolution frame", () => {
  expect(captureOptions.deviceScaleFactor).toBe(2);
});
`,
  );
  writeFileSync(
    join(worktrees.workflowStatus.path, "src/status.ts"),
    `export const workflowStates = ["idle", "working", "blocked", "done"];
`,
  );
}

function worktreeButton(page, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .getByRole("navigation", { name: "Workspaces" })
    .getByRole("button", { name: new RegExp(`^${escaped}(?:,|$)`) });
}

async function openTerminal(page, workspaceName, worktreeName) {
  await worktreeButton(page, worktreeName).click();
  const terminal = page.getByRole("application", {
    name: `${workspaceName} ${worktreeName} interactive Pi terminal`,
  });
  await terminal.waitFor({ state: "visible", timeout: 15_000 });
  const renderedRows = terminal.locator(".xterm-rows");
  await renderedRows.waitFor({ state: "visible", timeout: 15_000 });
  const rowsElement = await renderedRows.elementHandle();
  if (!rowsElement) throw new Error("Pi terminal rows were not rendered");
  await page.waitForFunction(
    (element) => (element.textContent ?? "").trim().length > 0,
    rowsElement,
    { timeout: 15_000 },
  );
  return terminal;
}

async function captureImage(page, path) {
  await page.screenshot({
    path,
    type: "png",
    animations: "disabled",
  });
  return statSync(path).size;
}

function removeCaptureFile(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // Preserve the original publication error.
  }
}

function publishCapturePair(
  stagedTerminal,
  stagedDiff,
  terminalOutput,
  diffOutput,
) {
  const suffix = `.tmp-${process.pid}`;
  const pendingTerminal = `${terminalOutput}${suffix}`;
  const pendingDiff = `${diffOutput}${suffix}`;
  mkdirSync(dirname(terminalOutput), { recursive: true });
  try {
    copyFileSync(stagedTerminal, pendingTerminal);
    copyFileSync(stagedDiff, pendingDiff);
    renameSync(pendingTerminal, terminalOutput);
    renameSync(pendingDiff, diffOutput);
  } catch (error) {
    removeCaptureFile(pendingTerminal);
    removeCaptureFile(pendingDiff);
    removeCaptureFile(terminalOutput);
    removeCaptureFile(diffOutput);
    throw error;
  }
}

function reportCapture(path, label, size) {
  process.stdout.write(
    `Captured ${label} ${viewport.width * deviceScaleFactor}×${viewport.height * deviceScaleFactor} promotional screenshot (${Math.round(size / 1024)} KiB):\n${path}\n`,
  );
}

async function prepareFrame(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
}

async function main() {
  const { outputDirectory, terminalOutput, diffOutput } = parseArguments(
    process.argv.slice(2),
  );
  const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-dash-promo-"));
  let browser;
  let daemon;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await browser?.close().catch(() => undefined);
      await stopProcess(daemon);
      await rm(temporaryRoot, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  const handleSignal = (signal) => {
    void cleanup().finally(() => {
      process.kill(process.pid, signal);
    });
  };
  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    const outputFile = join(temporaryRoot, "runtime", "bootstrap-url");
    const promoPiSource = resolve(projectRoot, "scripts/fixtures/promo-pi.mjs");
    const promoPi = join(temporaryRoot, "promo-pi.mjs");
    const stagedOutputDirectory = join(temporaryRoot, "captures");
    const stagedTerminal = join(stagedOutputDirectory, terminalFilename);
    const stagedDiff = join(stagedOutputDirectory, diffFilename);
    const serverEntry = resolve(projectRoot, "apps/server/dist/cli.js");
    const piDashRepository = createRepository(temporaryRoot, "pi-dash", {
      "README.md": "# Pi Dash\n\nA local dashboard for focused Pi workflows.\n",
      "src/capture.ts": `export const captureOptions = {
  viewport: { width: 1280, height: 800 },
  animations: true,
};
`,
      "src/status.ts": `export const workflowStates = ["idle", "working", "done"];
`,
    });
    const docsRepository = createRepository(temporaryRoot, "documentation", {
      "README.md": "# Pi Dash Documentation\n",
      "guides/install.md": "# Installation\n\nInstall Pi Dash on Linux.\n",
    });

    copyFileSync(promoPiSource, promoPi);
    chmodSync(promoPi, 0o755);
    mkdirSync(stagedOutputDirectory, { recursive: true });
    const port = await availablePort();
    let daemonOutput = "";
    daemon = spawn(
      process.execPath,
      [
        serverEntry,
        "--port",
        String(port),
        "--data-dir",
        join(temporaryRoot, "data"),
        "--config-dir",
        join(temporaryRoot, "config"),
        "--runtime-dir",
        join(temporaryRoot, "runtime"),
        "--bootstrap-output",
        outputFile,
        "--native-dialog",
        "disabled",
        "--pi-executable",
        promoPi,
        "--terminal-cache-size",
        "6",
        "--terminal-initial-rows",
        "60",
        "--log-level",
        "warn",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          NODE_ENV: "production",
          PI_DASH_NO_OPEN: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    daemon.stdout?.on("data", (chunk) => {
      daemonOutput = `${daemonOutput}${chunk}`.slice(-32_000);
    });
    daemon.stderr?.on("data", (chunk) => {
      daemonOutput = `${daemonOutput}${chunk}`.slice(-32_000);
    });

    const bootstrapUrl = await waitForDaemon(
      daemon,
      outputFile,
      port,
      () => daemonOutput,
    );
    const executablePath = findChromiumExecutable();
    if (!executablePath) {
      throw new Error(
        "Chrome or Chromium was not found. Install one or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.",
      );
    }
    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor,
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("status", { name: "Daemon connection" })
      .waitFor({ state: "visible" });

    const worktrees = await stageData(page, piDashRepository, docsRepository);
    addDemoChanges(worktrees);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Expand Pi Dash" }).click();
    await page.getByRole("button", { name: "Expand Documentation" }).click();

    await openTerminal(page, "Pi Dash", "Terminal polish");
    await openTerminal(page, "Pi Dash", "Workflow status");
    await openTerminal(page, "Documentation", "Installation guide");
    const promoTerminal = await openTerminal(
      page,
      "Pi Dash",
      "Capture tooling",
    );
    const fullPromoMarker = promoTerminal.getByText(
      "Persistent task, TODO, and model status footer",
    );
    await fullPromoMarker.waitFor({ state: "visible", timeout: 15_000 });

    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation: none !important;
          caret-color: transparent !important;
          transition: none !important;
        }
        html, body { cursor: none !important; }
        .xterm-cursor-layer { opacity: 0 !important; }
      `,
    });
    await prepareFrame(page);
    const terminalSize = await captureImage(page, stagedTerminal);

    const diffButton = page.getByRole("button", { name: /^View changes:/ });
    await diffButton.waitFor({ state: "visible" });
    await diffButton.click();
    await page
      .getByRole("heading", { name: "Changes" })
      .waitFor({ state: "visible" });
    await page.getByText("captureOptions").first().waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await fullPromoMarker.waitFor({ state: "visible", timeout: 15_000 });
    await prepareFrame(page);
    const diffSize = await captureImage(page, stagedDiff);

    mkdirSync(outputDirectory, { recursive: true });
    publishCapturePair(stagedTerminal, stagedDiff, terminalOutput, diffOutput);
    reportCapture(terminalOutput, "terminal-only", terminalSize);
    reportCapture(diffOutput, "diff-open", diffSize);
  } finally {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
    await cleanup();
  }
}

main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${redactSensitiveText(message)}\n`);
  process.exitCode = 1;
});
