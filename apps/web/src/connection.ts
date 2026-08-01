export type StartupState =
  | { status: "connecting"; message: string }
  | { status: "ready"; message: string }
  | { status: "disconnected"; message: string }
  | { status: "migration-failed"; message: string }
  | { status: "unauthorized"; message: string };

export type StartupEvent =
  | { type: "CONNECT" }
  | { type: "READY" }
  | { type: "UNAUTHORIZED" }
  | { type: "MIGRATION_FAILED"; message?: string }
  | { type: "DISCONNECTED"; message?: string };

export const initialStartupState: StartupState = {
  status: "connecting",
  message: "Connecting to the local daemon…",
};

export function reduceStartupState(
  _state: StartupState,
  event: StartupEvent,
): StartupState {
  switch (event.type) {
    case "CONNECT":
      return initialStartupState;
    case "READY":
      return { status: "ready", message: "Connected" };
    case "UNAUTHORIZED":
      return {
        status: "unauthorized",
        message: "Launch authentication is required",
      };
    case "MIGRATION_FAILED":
      return {
        status: "migration-failed",
        message: event.message ?? "The database migration failed",
      };
    case "DISCONNECTED":
      return {
        status: "disconnected",
        message: event.message ?? "The local daemon is unavailable",
      };
  }
}
