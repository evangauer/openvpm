import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ignoreBuildScript = resolve(process.cwd(), "scripts/vercel-ignore-build.sh");

function ignoredBuildStatus(overrides: Record<string, string>): number | null {
  return spawnSync("bash", [ignoreBuildScript], {
    cwd: process.cwd(),
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_DEMO_MODE: "true",
      ...overrides,
    },
    encoding: "utf8",
  }).status;
}

describe("Vercel ignored build policy", () => {
  it("lets an operator force a protected demo-mode preview rebuild", () => {
    // Vercel interprets exit 1 as "continue building".
    expect(
      ignoredBuildStatus({ OPENVPM_FORCE_PREVIEW_BUILD: "true" }),
    ).toBe(1);
  });

  it("continues skipping ordinary demo-mode preview builds", () => {
    // Vercel interprets exit 0 as "skip this deployment".
    expect(ignoredBuildStatus({})).toBe(0);
  });

  it("also skips ordinary app-mode previews while credentials are quarantined", () => {
    expect(ignoredBuildStatus({ NEXT_PUBLIC_DEMO_MODE: "false" })).toBe(0);
  });

  it("always lets production builds proceed to the release-SHA gate", () => {
    expect(ignoredBuildStatus({ VERCEL_ENV: "production" })).toBe(1);
  });
});
