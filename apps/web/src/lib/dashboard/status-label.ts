import type { StartupState } from "../../connection.js";

export function getStatusString(status: StartupState["status"]): string {
  if (status === "connecting") return "Connecting";
  if (status === "unauthorized") return "Unauthorized";
  if (status === "migration-failed") return "Database setup failed";
  if (status === "disconnected") return "Disconnected";
  if (status === "ready") return "Connected";
  return "";
}
