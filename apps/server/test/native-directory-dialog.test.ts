import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeDirectoryDialog,
  DialogBusyError,
} from "../src/platform/native-directory-dialog.js";
import {
  ProcessExecutionError,
  runProcess,
  type ProcessResult,
  type ProcessRunner,
} from "../src/process/safe-process.js";

const roots: string[] = [];
function executableDirectory(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-dialog-"));
  roots.push(root);
  for (const name of names) {
    const path = join(root, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o700);
  }
  return root;
}

const selected: ProcessResult = {
  exitCode: 0,
  signal: null,
  stdout: "/home/user/project\n",
  stderr: "",
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native Linux directory dialog", () => {
  it("prefers zenity and invokes its exact argument array", async () => {
    const path = executableDirectory(["zenity", "kdialog"]);
    const runner = vi.fn<ProcessRunner>().mockResolvedValue(selected);
    const dialogs = await createNativeDirectoryDialog({
      mode: "auto",
      env: { PATH: path, DISPLAY: ":1", HOME: path },
      runner,
    });

    await expect(dialogs.probe()).resolves.toEqual({
      available: true,
      adapter: "zenity",
    });
    await expect(dialogs.chooseDirectory({})).resolves.toEqual({
      cancelled: false,
      path: "/home/user/project",
      adapter: "zenity",
    });
    expect(runner).toHaveBeenCalledWith(
      join(path, "zenity"),
      ["--file-selection", "--directory"],
      expect.objectContaining({ cwd: path, timeoutMs: 120_000 }),
    );
  });

  it("preserves path whitespace while removing only the picker terminator", async () => {
    const path = executableDirectory(["zenity"]);
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      ...selected,
      stdout: "/tmp/project with suffix \n\n",
    });
    const dialogs = await createNativeDirectoryDialog({
      mode: "zenity",
      env: { PATH: path, DISPLAY: ":1", HOME: path },
      runner,
    });
    await expect(dialogs.chooseDirectory({})).resolves.toEqual({
      cancelled: false,
      path: "/tmp/project with suffix \n",
      adapter: "zenity",
    });
  });

  it("executes a probed adapter directly with the documented arguments", async () => {
    const path = executableDirectory([]);
    const argumentsFile = join(path, "arguments");
    const executable = join(path, "zenity");
    writeFileSync(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\nprintf '%s\\n' '/tmp/selected project'\n`,
    );
    chmodSync(executable, 0o700);
    const dialogs = await createNativeDirectoryDialog({
      mode: "zenity",
      env: { PATH: path, DISPLAY: ":1", HOME: path },
    });

    await expect(dialogs.chooseDirectory({})).resolves.toMatchObject({
      path: "/tmp/selected project",
      adapter: "zenity",
    });
    expect(readFileSync(argumentsFile, "utf8")).toBe(
      "--file-selection\n--directory\n",
    );
  });

  it("falls back to kdialog and distinguishes cancellation", async () => {
    const path = executableDirectory(["kdialog"]);
    const runner = vi.fn<ProcessRunner>().mockResolvedValue({
      exitCode: 1,
      signal: null,
      stdout: "",
      stderr: "",
    });
    const dialogs = await createNativeDirectoryDialog({
      mode: "auto",
      env: { PATH: path, WAYLAND_DISPLAY: "wayland-0", HOME: path },
      runner,
    });

    await expect(dialogs.chooseDirectory({})).resolves.toEqual({
      cancelled: true,
      adapter: "kdialog",
    });
    expect(runner.mock.calls[0]?.[1]).toEqual(["--getexistingdirectory"]);
  });

  it("enforces one active dialog and aborts it during shutdown", async () => {
    const path = executableDirectory(["zenity"]);
    let observedSignal: AbortSignal | undefined;
    const runner: ProcessRunner = async (_executable, _args, options) =>
      new Promise((resolve, reject) => {
        observedSignal = options.signal;
        options.signal?.addEventListener(
          "abort",
          () => reject(new ProcessExecutionError("aborted", "cancelled")),
          { once: true },
        );
        void resolve;
      });
    const dialogs = await createNativeDirectoryDialog({
      mode: "zenity",
      env: { PATH: path, DISPLAY: ":1", HOME: path },
      runner,
    });

    const active = dialogs.chooseDirectory({});
    await expect(dialogs.chooseDirectory({})).rejects.toBeInstanceOf(
      DialogBusyError,
    );
    dialogs.close();
    await expect(active).rejects.toMatchObject({ reason: "aborted" });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("reports unavailable capability without a graphical session", async () => {
    const path = executableDirectory(["zenity"]);
    const dialogs = await createNativeDirectoryDialog({
      mode: "auto",
      env: { PATH: path, HOME: path },
    });
    await expect(dialogs.probe()).resolves.toMatchObject({
      available: false,
      reason: "No graphical display session is available",
    });
  });
});

describe("safe process runner", () => {
  it("bounds execution time and output", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ reason: "timeout" });

    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(100))"],
        {
          cwd: process.cwd(),
          env: process.env,
          maxOutputBytes: 10,
        },
      ),
    ).rejects.toMatchObject({ reason: "output_limit" });
  });
});
