import { createHash } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { flockSync } from "fs-ext";

export class GitMutationBusyError extends Error {
  readonly code = "GIT_OPERATION_BUSY";

  constructor() {
    super("Another Git mutation is already in progress for this repository");
    this.name = "GitMutationBusyError";
  }
}

export interface GitMutationLock {
  runExclusive<T>(
    gitCommonDir: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

function secureLockRoot(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error(
      "Managed Git locks require a platform with numeric user IDs",
    );
  }
  const runtimeParent = `/run/user/${uid}`;
  let root: string;
  try {
    const parent = statSync(runtimeParent);
    if (!parent.isDirectory() || parent.uid !== uid) throw new Error();
    root = resolve(runtimeParent, "pi-dash-git-locks");
  } catch {
    root = `/tmp/pi-dash-${uid}`;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(root);
  chmodSync(root, 0o700);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    realpathSync(root) !== root
  ) {
    throw new Error("Git mutation lock directory is not securely owned");
  }
  return root;
}

export function createGitMutationLock(
  options: {
    root?: string;
  } = {},
): GitMutationLock {
  const root = options.root ?? secureLockRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const rootMetadata = lstatSync(root);
  const uid = process.getuid?.();
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    (uid !== undefined && rootMetadata.uid !== uid)
  ) {
    throw new Error("Git mutation lock directory is not securely owned");
  }
  const canonicalRoot = realpathSync(root);
  const active = new Set<string>();

  return {
    async runExclusive(gitCommonDir, operation) {
      const canonicalCommonDir = realpathSync(gitCommonDir);
      const key = createHash("sha256").update(canonicalCommonDir).digest("hex");
      if (active.has(key)) throw new GitMutationBusyError();
      active.add(key);
      const lockPath = resolve(canonicalRoot, `${key}.lock`);
      let descriptor: number | undefined;
      let locked = false;
      try {
        descriptor = openSync(
          lockPath,
          constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
        fchmodSync(descriptor, 0o600);
        const opened = fstatSync(descriptor);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          (uid !== undefined && opened.uid !== uid)
        ) {
          throw new Error("Git mutation lock file is not secure");
        }
        try {
          flockSync(descriptor, "exnb");
          locked = true;
        } catch {
          throw new GitMutationBusyError();
        }
        const current = lstatSync(lockPath);
        if (
          current.isSymbolicLink() ||
          current.dev !== opened.dev ||
          current.ino !== opened.ino
        ) {
          throw new Error("Git mutation lock file changed while acquiring it");
        }
        return await operation();
      } finally {
        try {
          if (locked && descriptor !== undefined) flockSync(descriptor, "un");
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
          active.delete(key);
        }
      }
    },
  };
}
