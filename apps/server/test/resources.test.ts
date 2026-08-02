import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAppResources } from "../src/resources.js";

describe("application resources", () => {
  it("resolves development resources independently of cwd", () => {
    const priorCwd = process.cwd();
    const repositoryRoot = resolve(
      fileURLToPath(new URL("../../..", import.meta.url)),
    );
    process.chdir("/tmp");
    try {
      const resources = resolveAppResources({});
      expect(resources.root).toBe(repositoryRoot);
      expect(resources.migrations).toBe(resolve(repositoryRoot, "migrations"));
      expect(resources.staticAssets).toBe(
        resolve(repositoryRoot, "apps/web/dist"),
      );
      expect(resources.piExtension).toBe(
        resolve(repositoryRoot, "packages/pi-extension/dist/runtime.js"),
      );
    } finally {
      process.chdir(priorCwd);
    }
  });

  it("uses an absolute packaged resource root", () => {
    const resources = resolveAppResources({
      PI_DASH_RESOURCE_ROOT: "/opt/Pi Dash/resources/pi-dash",
    });
    expect(resources.staticAssets).toBe(
      "/opt/Pi Dash/resources/pi-dash/apps/web/dist",
    );
  });

  it("rejects a relative packaged resource root", () => {
    expect(() =>
      resolveAppResources({ PI_DASH_RESOURCE_ROOT: "relative/resources" }),
    ).toThrow("PI_DASH_RESOURCE_ROOT must be absolute");
  });
});
