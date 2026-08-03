import type {
  RepositoryHealth,
  WorktreeHealth,
  WorktreeLifecycle,
} from "@pi-dash/contracts";

export interface HealthIssue {
  title: string;
  description: string;
}

const repositoryIssues = {
  missing: {
    title: "Repository directory is missing",
    description:
      "The registered repository directory no longer exists at the expected path.",
  },
  inaccessible: {
    title: "Repository is inaccessible",
    description:
      "Pi Dash cannot access the registered path. Check its filesystem permissions and parent directory access.",
  },
  not_git: {
    title: "Path is no longer a Git worktree",
    description:
      "The registered path exists, but Git no longer recognizes it as a worktree.",
  },
  changed: {
    title: "Repository identity changed",
    description:
      "The path now resolves to a different repository or Git common directory than the one originally registered.",
  },
} satisfies Record<Exclude<RepositoryHealth, "healthy">, HealthIssue>;

const worktreeIssues = {
  missing: {
    title: "Worktree directory is missing",
    description:
      "The managed worktree directory no longer exists at the expected path.",
  },
  git_mismatch: {
    title: "Git worktree details do not match",
    description:
      "The directory or Git registration no longer matches the recorded path, branch, and parent repository.",
  },
  locked: {
    title: "Worktree is locked",
    description:
      "Git reports this worktree as locked. Unlock it with Git before opening Pi.",
  },
  unknown: {
    title: "Worktree health is not confirmed",
    description:
      "Pi Dash has not confirmed the current Git state. Wait for active operations to finish, or reconcile the workspace to check again.",
  },
} satisfies Record<Exclude<WorktreeHealth, "healthy">, HealthIssue>;

export function healthLabel(health: RepositoryHealth | WorktreeHealth): string {
  return health.replaceAll("_", " ");
}

export function repositoryHealthIssue(
  health: RepositoryHealth,
): HealthIssue | undefined {
  return health === "healthy" ? undefined : repositoryIssues[health];
}

export function worktreeHealthIssue(
  health: WorktreeHealth,
  lifecycle: WorktreeLifecycle,
): HealthIssue | undefined {
  if (health === "healthy") return undefined;
  if (health === "missing" && lifecycle === "removed") {
    return {
      title: "Worktree was removed",
      description:
        "The worktree directory is absent as expected. Its branch record remains available for final cleanup.",
    };
  }
  return worktreeIssues[health];
}
