import type BetterSqlite3 from "better-sqlite3";
import { createApplicationEvents } from "../src/events/application-events.js";
import { createStatusRepository } from "../src/status/status-repository.js";
import { createStatusService } from "../src/status/status-service.js";

export function createStatusTestServices(sqlite: BetterSqlite3.Database) {
  const statuses = createStatusService({
    repository: createStatusRepository(sqlite),
  });
  const events = createApplicationEvents({
    statuses: () => statuses.list(),
    runtimes: () => [],
    shellActivities: () => [],
    workspaceAttention: () => statuses.workspaceAttention(),
    environmentChanges: () => [],
  });
  return { statuses, events };
}
