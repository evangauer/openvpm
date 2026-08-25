import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("checks schema drift before building an exactly approved commit", () => {
    const fixture = mkdtempSync(join(tmpdir(), "openvpm-deploy-order-"));
    const fakePnpm = join(fixture, "pnpm");
    const calls = join(fixture, "calls.txt");
    const sha = "a".repeat(40);

    try {
      writeFileSync(
        fakePnpm,
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$PNPM_CALLS"\n',
      );
      chmodSync(fakePnpm, 0o700);

      const result = spawnSync("bash", ["scripts/vercel-build.sh"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH ?? ""}`,
          PNPM_CALLS: calls,
          VERCEL_ENV: "production",
          PRODUCTION_RELEASE_SHA: sha,
          VERCEL_GIT_COMMIT_SHA: sha,
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        "db:drift",
        "build",
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
