import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiAuth = readFileSync(new URL("../api-auth.ts", import.meta.url), "utf8");
const upload = readFileSync(
  new URL("../../app/api/upload/route.ts", import.meta.url),
  "utf8",
);
const health = readFileSync(
  new URL("../../app/api/health/route.ts", import.meta.url),
  "utf8",
);

describe("hosted recovery surface", () => {
  it("blocks API-key writes and agent runs for held clinics", () => {
    expect(apiAuth).toContain("practices.recoveryHold");
    expect(apiAuth).toContain("writeLikeScope && practice.recoveryHold");
    expect(apiAuth).toContain("API changes and agent runs remain paused");
  });

  it("keeps file writes behind a transactional recovery lease", () => {
    expect(upload).toContain("lockPracticeForExternalSideEffects");
    expect(upload).toContain("RECOVERY_HOLD_BLOCK_MESSAGE");
    expect(
      upload.indexOf("if (!(await lockPracticeForExternalSideEffects"),
    ).toBeLessThan(
      upload.indexOf("const body = await readRequestBytesWithLimit"),
    );
  });

  it("prevents readiness responses from being served stale", () => {
    expect(health).toContain('"Cache-Control": "no-store, max-age=0"');
  });
});
