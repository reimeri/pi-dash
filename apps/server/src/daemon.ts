import { join } from "node:path";
import type { Logger } from "pino";
import { buildHttpServer, type HttpServer } from "./app.js";
import { createAuthService, type AuthService } from "./auth.js";
import { loadConfig, type AppConfig } from "./config.js";
import { openDatabase, type DatabaseService } from "./database.js";
import { acquireDaemonLock, type DaemonLock } from "./lock.js";
import { createLogger } from "./logger.js";
import {
  loadOrCreateSnapshotKey,
  removeRuntimeFile,
  resolveAppPaths,
  secureWriteFile,
  type AppPaths,
} from "./paths.js";
import { createPiResolver } from "./pi/pi-resolver.js";
import { resolveAppResources } from "./resources.js";
import { createOriginPolicy } from "./security.js";
import {
  createApplicationEvents,
  type ApplicationEvents,
} from "./events/application-events.js";
import { createStatusRepository } from "./status/status-repository.js";
import {
  createStatusService,
  type StatusService,
} from "./status/status-service.js";
import {
  createStatusSocketServer,
  type StatusSocketServer,
} from "./status/status-socket-server.js";
import {
  createTerminalManager,
  type TerminalManager,
} from "./terminal/terminal-manager.js";
import {
  createPiTerminalEnvironment,
  createShellTerminalEnvironment,
} from "./terminal/environment.js";
import { resolveUserShell } from "./terminal/shell-resolver.js";
import { createGitDiffInspector } from "./git/git-diff-inspector.js";
import { createGitInspector } from "./git/git-inspector.js";
import { createGitWorktreeManager } from "./git/git-worktree-manager.js";
import { createGitWorkspaceSynchronizer } from "./git/git-workspace-sync.js";
import {
  createNativeDirectoryDialog,
  type NativeDirectoryDialogService,
} from "./platform/native-directory-dialog.js";
import {
  createWorkspaceService,
  type WorkspaceService,
} from "./workspaces/workspace-service.js";
import { createWorkspaceRepository } from "./workspaces/workspace-repository.js";
import { createBaseSnapshotSigner } from "./worktrees/base-snapshot.js";
import { createRemovalConfirmationSigner } from "./worktrees/removal-confirmation.js";
import { createGitMutationLock } from "./worktrees/git-mutation-lock.js";
import { createWorktreeLifecycleCoordinator } from "./worktrees/worktree-lifecycle.js";
import { createWorktreeRepository } from "./worktrees/worktree-repository.js";
import {
  createWorktreeService,
  type WorktreeService,
} from "./worktrees/worktree-service.js";

export interface Daemon {
  app: HttpServer;
  auth: AuthService;
  config: AppConfig;
  database: DatabaseService;
  terminals: TerminalManager;
  shellTerminals: TerminalManager;
  statuses: StatusService;
  paths: AppPaths;
  bootstrapUrl: string;
  markReady(): void;
  shutdown(): Promise<void>;
}

export async function createDaemon(
  options: {
    args?: readonly string[];
    env?: NodeJS.ProcessEnv;
    logger?: Logger;
  } = {},
): Promise<Daemon> {
  const env = options.env ?? process.env;
  const desktopHost = env.PI_DASH_DESKTOP === "true";
  const config = loadConfig(options.args ?? process.argv.slice(2), env);
  const resources = resolveAppResources(env);
  const logger = options.logger ?? createLogger(config.logLevel);
  const paths = resolveAppPaths(config, env);
  let lock: DaemonLock | undefined;
  let database: DatabaseService | undefined;
  let app: HttpServer | undefined;
  let auth: AuthService | undefined;
  let dialogs: NativeDirectoryDialogService | undefined;
  let workspaces: WorkspaceService | undefined;
  let worktrees: WorktreeService | undefined;
  let terminals: TerminalManager | undefined;
  let shellTerminals: TerminalManager | undefined;
  let statuses: StatusService | undefined;
  let statusSocket: StatusSocketServer | undefined;
  let applicationEvents: ApplicationEvents | undefined;
  let diagnosticsTimer: NodeJS.Timeout | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let bootstrapOutputWritten = false;
  let runtimeInfoWritten = false;

  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];
    if (diagnosticsTimer) clearInterval(diagnosticsTimer);
    diagnosticsTimer = undefined;
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (terminals) await attempt(() => terminals!.shutdown());
    if (shellTerminals) await attempt(() => shellTerminals!.shutdown());
    if (statusSocket) await attempt(() => statusSocket!.close());
    if (applicationEvents) await attempt(() => applicationEvents!.close());
    if (app) await attempt(() => app!.close());
    else {
      if (workspaces) await attempt(() => workspaces!.close());
      if (dialogs) await attempt(() => dialogs!.close());
    }
    if (auth) await attempt(() => auth!.clear());
    if (database) await attempt(() => database!.close());
    if (runtimeInfoWritten)
      await attempt(() => removeRuntimeFile(paths.runtimeInfo));
    if (bootstrapOutputWritten && config.bootstrapOutput) {
      await attempt(() => removeRuntimeFile(config.bootstrapOutput!));
    }
    if (lock) await attempt(() => lock!.release());
    await attempt(() => logger.flush());
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more daemon cleanup operations failed",
      );
    }
  };

  try {
    lock = acquireDaemonLock(paths.lock);
    database = await openDatabase({
      path: paths.database,
      migrationsDirectory: resources.migrations,
    });
    const policy = createOriginPolicy(config);
    auth = createAuthService({ policy });
    const git = await createGitInspector({ env });
    const gitWorktrees = await createGitWorktreeManager({ env });
    const gitWorkspaceSync = await createGitWorkspaceSynchronizer({ env });
    const gitDiffs = await createGitDiffInspector({ env });
    const pi = createPiResolver({
      executable: config.piExecutable,
      minimumVersion: config.piMinimumVersion,
      env,
      extensionPath: resources.piExtension,
    });
    dialogs = await createNativeDirectoryDialog({
      mode: config.nativeDialog,
      env,
    });
    const [gitAvailable, dialogCapability, piAvailable, ptyAvailable] =
      await Promise.all([
        git.probe(),
        dialogs.probe(),
        pi.probe().then(
          () => true,
          () => false,
        ),
        import("node-pty").then(
          () => true,
          () => false,
        ),
      ]);
    const workspaceRepository = createWorkspaceRepository(database.sqlite);
    const worktreeRepository = createWorktreeRepository(database.sqlite);
    const statusRepository = createStatusRepository(database.sqlite);
    statusRepository.resetActive(new Date().toISOString());
    statuses = createStatusService({ repository: statusRepository });
    statusSocket = createStatusSocketServer({
      path: join(paths.runtime, "status.sock"),
      statuses,
      logger,
    });
    let statusSocketAvailable = true;
    try {
      await statusSocket.start();
    } catch (error) {
      statusSocketAvailable = false;
      logger.warn(
        { errorName: (error as Error).name },
        "Workflow status socket unavailable; terminal runtime remains enabled",
      );
      await statusSocket.close().catch(() => undefined);
      statusSocket = undefined;
    }
    const gitMutationLock = createGitMutationLock();
    workspaces = createWorkspaceService({
      repository: workspaceRepository,
      git,
      syncer: gitWorkspaceSync,
      lock: gitMutationLock,
      onRepositoryChange: (workspace) =>
        applicationEvents?.publishWorkspaceUpdated(workspace),
      onOrderChange: (workspaceIds) =>
        applicationEvents?.publishWorkspaceOrderUpdated(workspaceIds),
    });
    const lifecycle = createWorktreeLifecycleCoordinator({
      repository: worktreeRepository,
    });
    const snapshotKey = loadOrCreateSnapshotKey(paths.snapshotKey);
    worktrees = createWorktreeService({
      repository: worktreeRepository,
      workspaces: workspaceRepository,
      git: gitWorktrees,
      diffs: gitDiffs,
      lock: gitMutationLock,
      lifecycle,
      snapshots: createBaseSnapshotSigner({ key: snapshotKey }),
      removalConfirmations: createRemovalConfirmationSigner({
        key: snapshotKey,
      }),
      managedRoot: paths.worktrees,
      stopRuntime: async (worktree) => {
        const results = await Promise.allSettled([
          terminals?.dispose(worktree.id),
          shellTerminals?.dispose(worktree.id),
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            "One or more worktree terminal runtimes could not be disposed",
          );
        }
      },
      onMembershipChange: (change) => {
        if (change.type === "removed") {
          applicationEvents?.publishWorktreeRemoved(
            change.worktreeId,
            change.workspaceId,
          );
        } else {
          statuses!.publishCurrent(change.worktreeId);
        }
      },
    });
    terminals = createTerminalManager({
      runtimeKind: "pi",
      lifecycle,
      getWorktree: (id) => worktrees!.get(id),
      verifyWorktree: (id) => worktrees!.verifyTerminalStart(id),
      resolveLaunch: async ({ worktreeId, runtimeId, statusToken }) => {
        const resolved = await pi.probe();
        return {
          executable: resolved.executable,
          args: ["--extension", resolved.extensionPath],
          env: createPiTerminalEnvironment({
            inherited: env,
            runtimeDirectory: paths.runtime,
            runtimeId,
            worktreeId,
            statusToken,
          }),
        };
      },
      initialCols: config.terminalInitialCols,
      initialRows: config.terminalInitialRows,
      outputBufferBytes: config.terminalOutputBufferBytes,
      maxSocketBufferedBytes: config.terminalMaxSocketBufferedBytes,
      stopGraceMs: config.terminalStopGraceMs,
      status: {
        registerRuntime(worktreeId, runtimeId, token) {
          statuses!.registerRuntime(worktreeId, runtimeId, token);
          if (!statusSocketAvailable) statuses!.markUnsupported(worktreeId);
        },
        resetRuntime: (worktreeId, runtimeId) =>
          statuses!.resetRuntime(worktreeId, runtimeId),
      },
      onRuntimeState: (runtime) => applicationEvents?.publishRuntime(runtime),
    });
    shellTerminals = createTerminalManager({
      runtimeKind: "shell",
      lifecycle,
      getWorktree: (id) => worktrees!.get(id),
      verifyWorktree: (id) => worktrees!.verifyTerminalStart(id),
      resolveLaunch: async () => ({
        executable: await resolveUserShell(env),
        args: [],
        env: createShellTerminalEnvironment(env),
      }),
      processScope: "session",
      initialCols: config.terminalInitialCols,
      initialRows: config.terminalInitialRows,
      outputBufferBytes: config.terminalOutputBufferBytes,
      maxSocketBufferedBytes: config.terminalMaxSocketBufferedBytes,
      stopGraceMs: config.terminalStopGraceMs,
      onShellActivity: (activity) =>
        applicationEvents?.publishShellActivity(activity),
    });
    applicationEvents = createApplicationEvents({
      statuses: () => statuses!.list(),
      runtimes: () =>
        statuses!.list().map((status) => terminals!.get(status.worktreeId)),
      shellActivities: () => shellTerminals!.activities(),
      workspaceAttention: () => statuses!.workspaceAttention(),
    });
    statuses.setPublisher((status) => applicationEvents!.publishStatus(status));
    await worktrees.reconcile();
    app = await buildHttpServer({
      config,
      database,
      auth,
      policy,
      logger,
      staticDirectory: config.staticDir ?? resources.staticAssets,
      dialogs,
      workspaces,
      worktrees,
      terminals,
      shellTerminals,
      statuses,
      events: applicationEvents,
      capabilities: {
        git: gitAvailable,
        pi: piAvailable,
        nativeDirectoryDialog: dialogCapability.available,
        pty: ptyAvailable,
      },
    });
    workspaces.startHealthRefresh();
    const logDiagnostics = () => {
      try {
        const memory = process.memoryUsage();
        const cpu = process.cpuUsage();
        const resources = process.resourceUsage();
        const activeResources = process
          .getActiveResourcesInfo()
          .reduce<Record<string, number>>((counts, resource) => {
            counts[resource] = (counts[resource] ?? 0) + 1;
            return counts;
          }, {});
        const diagnostics = {
          pid: process.pid,
          nodeVersion: process.version,
          uptimeSeconds: Math.floor(process.uptime()),
          cpuMicros: {
            user: cpu.user,
            system: cpu.system,
          },
          memoryBytes: {
            rss: memory.rss,
            heapTotal: memory.heapTotal,
            heapUsed: memory.heapUsed,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers,
            maxRss: resources.maxRSS * 1024,
          },
          ioOperations: {
            fsRead: resources.fsRead,
            fsWrite: resources.fsWrite,
          },
          contextSwitches: {
            voluntary: resources.voluntaryContextSwitches,
            involuntary: resources.involuntaryContextSwitches,
          },
          terminals: {
            pi: terminals!.diagnostics(),
            shell: shellTerminals!.diagnostics(),
          },
          activeResources,
        };
        if (logger.isLevelEnabled("info")) {
          logger.info(diagnostics, "Daemon diagnostics");
        } else if (desktopHost) {
          process.stdout.write(
            `${JSON.stringify({ level: 30, time: Date.now(), ...diagnostics, msg: "Daemon diagnostics" })}\n`,
          );
        }
      } catch {
        // Diagnostics are best-effort and must never affect daemon lifecycle.
      }
    };
    const bootstrapUrl = `${policy.serverOrigin}/auth/bootstrap?token=${encodeURIComponent(auth.bootstrapToken)}`;
    if (config.bootstrapOutput) {
      secureWriteFile(config.bootstrapOutput, `${bootstrapUrl}\n`);
      bootstrapOutputWritten = true;
    }

    const daemon: Daemon = {
      app,
      auth,
      config,
      database,
      terminals,
      shellTerminals,
      statuses,
      paths,
      bootstrapUrl,
      markReady() {
        secureWriteFile(
          paths.runtimeInfo,
          `${JSON.stringify({ pid: process.pid, host: config.host, port: config.port, version: "0.1.0" })}\n`,
        );
        runtimeInfoWritten = true;
        logDiagnostics();
        diagnosticsTimer ??= setInterval(logDiagnostics, 60_000);
        diagnosticsTimer.unref();
      },
      shutdown() {
        shutdownPromise ??= cleanup();
        return shutdownPromise;
      },
    };
    return daemon;
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Daemon startup and cleanup both failed",
      );
    }
    throw error;
  }
}
