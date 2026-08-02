import Fastify from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { registerWorktreeRoutes } from "../src/worktrees/worktree-routes.js";
import { createUnavailableWorktreeService } from "./worktree-service-stub.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("worktree diff routes", () => {
  it("returns no-store summary and full diff contracts", async () => {
    const app = Fastify({ loggerInstance: pino({ level: "silent" }) });
    apps.push(app);
    const worktreeId = "2cb84366-6fb7-4a60-b15e-6726381b190c";
    const summary = {
      worktreeId,
      headCommit: "a".repeat(40),
      snapshotId: "b".repeat(64),
      hasChanges: true,
      filesChanged: 1,
      additions: 2,
      deletions: 1,
      binaryFiles: 0,
      checkedAt: "2026-01-01T00:00:00.000Z",
    };
    const worktrees = {
      ...createUnavailableWorktreeService(),
      diffSummary: async () => summary,
      diff: async () => ({
        ...summary,
        patch: "diff --git a/file.ts b/file.ts\n",
        truncated: false,
        omittedFiles: [],
      }),
    };
    await registerWorktreeRoutes(app, { worktrees });

    const summaryResponse = await app.inject({
      method: "GET",
      url: `/api/v1/worktrees/${worktreeId}/diff-summary`,
    });
    expect(summaryResponse.statusCode).toBe(200);
    expect(summaryResponse.headers["cache-control"]).toBe("no-store");
    expect(summaryResponse.json()).toEqual(summary);

    const diffResponse = await app.inject({
      method: "GET",
      url: `/api/v1/worktrees/${worktreeId}/diff`,
    });
    expect(diffResponse.statusCode).toBe(200);
    expect(diffResponse.headers["cache-control"]).toBe("no-store");
    expect(diffResponse.json()).toMatchObject({
      ...summary,
      truncated: false,
      omittedFiles: [],
    });
  });
});
