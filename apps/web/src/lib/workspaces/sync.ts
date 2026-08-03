import type { WorkspaceSyncStatus } from "@pi-dash/contracts";

export function syncStatusLabel(status: WorkspaceSyncStatus): string {
  switch (status) {
    case "synchronized":
      return "Up to date with upstream";
    case "syncable":
      return "Behind upstream";
    case "ahead":
      return "Ahead of upstream";
    case "diverged":
      return "Diverged from upstream";
    case "dirty":
      return "Local changes present";
    case "unknown":
      return "Not checked";
  }
}
