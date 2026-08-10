import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiResolver } from "../src/pi/pi-resolver.js";

const roots: string[] = [];

function fixture(options: { failFirst?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-dash-pi-resolver-"));
  roots.push(root);
  const executable = join(root, "pi");
  const extensionPath = join(root, "extension.js");
  const countPath = join(root, "probe-count");
  writeFileSync(countPath, "0");
  writeFileSync(extensionPath, "export {};\n");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const countPath = process.env.PI_RESOLVER_COUNT_PATH;
const count = Number(readFileSync(countPath, "utf8")) + 1;
writeFileSync(countPath, String(count));
if (process.env.PI_RESOLVER_FAIL_FIRST === "1" && count === 1) process.exit(1);
process.stdout.write("pi 0.83.0\\n");
`,
  );
  chmodSync(executable, 0o755);

  const resolver = createPiResolver({
    executable,
    minimumVersion: "0.83.0",
    extensionPath,
    env: {
      ...process.env,
      PI_RESOLVER_COUNT_PATH: countPath,
      ...(options.failFirst ? { PI_RESOLVER_FAIL_FIRST: "1" } : {}),
    },
  });

  return {
    resolver,
    probeCount: () => Number(readFileSync(countPath, "utf8")),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Pi resolver", () => {
  it("shares and caches a successful version probe", async () => {
    const { resolver, probeCount } = fixture();

    const [first, second] = await Promise.all([
      resolver.probe(),
      resolver.probe(),
    ]);
    expect(first).toEqual(second);
    expect(probeCount()).toBe(1);

    first.version = "0.0.0";
    await expect(resolver.probe()).resolves.toMatchObject({
      version: "0.83.0",
    });
    expect(probeCount()).toBe(1);
  });

  it("retries after a failed version probe", async () => {
    const { resolver, probeCount } = fixture({ failFirst: true });

    const failures = await Promise.allSettled([
      resolver.probe(),
      resolver.probe(),
    ]);
    expect(failures.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    for (const failure of failures) {
      if (failure.status !== "rejected") throw new Error("Probe should fail");
      expect(failure.reason).toMatchObject({ code: "PI_UNAVAILABLE" });
    }
    expect(probeCount()).toBe(1);

    await expect(resolver.probe()).resolves.toMatchObject({
      version: "0.83.0",
    });
    expect(probeCount()).toBe(2);

    await resolver.probe();
    expect(probeCount()).toBe(2);
  });
});
