import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("hosted deployment ordering", () => {
  it("gates production promotion on an exact approved commit and schema readiness", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      buildCommand?: string;
    };
    const buildScript = readFileSync("scripts/vercel-build.sh", "utf8");

    expect(vercel.buildCommand).toBe("bash scripts/vercel-build.sh");
    expect(buildScript).toContain(
      'if [ "${VERCEL_ENV:-}" = "production" ]',
    );
    expect(buildScript).toContain('release_sha="${PRODUCTION_RELEASE_SHA:-}"');
    expect(buildScript).toContain('commit_sha="${VERCEL_GIT_COMMIT_SHA:-}"');
    expect(buildScript).toContain("^[0-9a-f]{40}$");
    expect(buildScript).toContain('[ "$release_sha" != "$commit_sha" ]');
    expect(buildScript).toContain(
      "Production release approval is absent or does not match this exact commit",
    );
    expect(buildScript).toContain("pnpm db:drift");
    expect(buildScript).toContain("schema_attempt_limit=30");
    expect(buildScript).toContain("refusing production promotion");
    expect(buildScript.trimEnd()).toMatch(/pnpm build$/);
  });

  it("fails before any build when the production approval does not match", () => {
    const result = spawnSync("bash", ["scripts/vercel-build.sh"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        VERCEL_ENV: "production",
        PRODUCTION_RELEASE_SHA: "0".repeat(40),
        VERCEL_GIT_COMMIT_SHA: "1".repeat(40),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "Production release approval is absent or does not match this exact commit",
    );
    expect(result.stdout).not.toContain("Database migration is still in progress");
  });
});
