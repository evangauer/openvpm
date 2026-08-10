import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("hosted deployment ordering", () => {
  it("gates production application promotion on schema readiness", () => {
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      buildCommand?: string;
    };
    const buildScript = readFileSync("scripts/vercel-build.sh", "utf8");

    expect(vercel.buildCommand).toBe("bash scripts/vercel-build.sh");
    expect(buildScript).toContain(
      'if [ "${VERCEL_ENV:-}" = "production" ]',
    );
    expect(buildScript).toContain("pnpm db:drift");
    expect(buildScript).toContain("schema_attempt_limit=30");
    expect(buildScript).toContain("refusing production promotion");
    expect(buildScript.trimEnd()).toMatch(/pnpm build$/);
  });
});
