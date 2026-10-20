import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(__dirname, "../..");
const rootUrl = "postgresql://fixture:fixture@localhost:5432/root_fixture";
const shellUrl = "postgresql://fixture:fixture@localhost:5432/shell_fixture";
const appUrl = "postgresql://fixture:fixture@localhost:5432/app_fixture";

function loadFixture(
  files: Record<string, string>,
  phase = "phase-development-server",
  overrides: Record<string, string> = {}
) {
  const root = mkdtempSync(join(tmpdir(), "openvpm-root-env-"));
  const web = join(root, "apps/web");
  try {
    mkdirSync(join(web, "lib"), { recursive: true });
    copyFileSync(join(webRoot, "next.config.js"), join(web, "next.config.js"));
    copyFileSync(join(webRoot, "lib/security-headers.js"), join(web, "lib/security-headers.js"));
    symlinkSync(join(webRoot, "node_modules"), join(web, "node_modules"), "dir");
    for (const [name, value] of Object.entries(files)) {
      writeFileSync(join(root, name), value);
    }

    // A new process per case isolates @next/env's cache and initialEnv. Use
    // Next's real config loader, which loads apps/web env before our config.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: phase === "phase-development-server" ? "development" : "production",
      ...overrides,
    };
    const result = spawnSync(process.execPath, ["-e", `
      const loadConfig = require("next/dist/server/config").default;
      const nextEnv = require(require.resolve("@next/env", {
        paths: [require.resolve("next/package.json")]
      }));
      loadConfig(${JSON.stringify(phase)}, process.cwd()).then(() => {
        // Next can reset env when initializing workers; root values must last.
        nextEnv.resetEnv();
        console.log("RESULT:" + JSON.stringify({
          databaseUrl: process.env.DATABASE_URL ?? null,
          rootMarker: process.env.ROOT_ENV_FIXTURE ?? null
        }));
      }).catch((error) => { console.error(error.message); process.exitCode = 1; });
    `], { cwd: web, env, encoding: "utf8", timeout: 15_000 });
    return { ...result, root };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function values(result: ReturnType<typeof loadFixture>) {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const output = result.stdout.split("\n").find((line) => line.startsWith("RESULT:"));
  expect(output).toBeDefined();
  return JSON.parse(output!.slice("RESULT:".length));
}

describe("web development root env loading", () => {
  it("loads the root .env through Next's real config loader", () => {
    expect(values(loadFixture({ ".env": `DATABASE_URL=${rootUrl}\nROOT_ENV_FIXTURE=root` })))
      .toEqual({ databaseUrl: rootUrl, rootMarker: "root" });
  });

  it("preserves shell exports and fills missing values from the root", () => {
    expect(values(loadFixture({ ".env": `DATABASE_URL=${rootUrl}\nROOT_ENV_FIXTURE=root` },
      undefined, { DATABASE_URL: shellUrl })))
      .toEqual({ databaseUrl: shellUrl, rootMarker: "root" });
  });

  it("preserves values already loaded from apps/web", () => {
    expect(values(loadFixture({
      ".env": `DATABASE_URL=${rootUrl}\nROOT_ENV_FIXTURE=root`,
      "apps/web/.env.local": `DATABASE_URL=${appUrl}`,
    }))).toEqual({ databaseUrl: appUrl, rootMarker: "root" });
  });

  it("uses Next's development env precedence and variable expansion", () => {
    expect(values(loadFixture({
      ".env": `DATABASE_URL=${rootUrl}\nROOT_ENV_FIXTURE=base`,
      ".env.development": "ROOT_ENV_FIXTURE=development",
      ".env.local": "ROOT_ENV_FIXTURE=local",
      ".env.development.local": "FIXTURE_NAME=development-local\nROOT_ENV_FIXTURE=$FIXTURE_NAME",
    }))).toEqual({ databaseUrl: rootUrl, rootMarker: "development-local" });
  });

  it.each([undefined, "   "])("stops dev startup with root setup instructions for DATABASE_URL=%s", (url) => {
    const result = loadFixture({}, undefined, url === undefined ? {} : { DATABASE_URL: url });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is missing");
    expect(result.stderr).toContain(join(result.root, ".env"));
    expect(result.stderr).toContain("cp .env.example .env");
    expect(result.stderr).not.toContain("Invalid email or password");
  });

  it.each(["phase-production-build", "phase-production-server"])("does not read root env files or require DATABASE_URL in %s", (phase) => {
    expect(values(loadFixture({ ".env": `DATABASE_URL=${rootUrl}\nROOT_ENV_FIXTURE=root` }, phase)))
      .toEqual({ databaseUrl: null, rootMarker: null });
  });

  it("preserves the production deployment environment", () => {
    expect(values(loadFixture({ ".env": `DATABASE_URL=${rootUrl}\nROOT_ENV_FIXTURE=root` },
      "phase-production-build", { DATABASE_URL: shellUrl, VERCEL: "1" })))
      .toEqual({ databaseUrl: shellUrl, rootMarker: null });
  });
});
