import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewLandingPath } from "../review-landing";

const trpcSource = readFileSync(
  new URL("../../server/trpc.ts", import.meta.url),
  "utf8",
);
const landingSource = readFileSync(
  new URL("../../app/(dashboard)/post-login/page.tsx", import.meta.url),
  "utf8",
);

describe("protected migration review access", () => {
  it("routes held clinics to their review workspace", () => {
    expect(reviewLandingPath({ recoveryHold: true })).toBe(
      "/migration-archive",
    );
    expect(reviewLandingPath({ recoveryHold: false })).toBe("/");
  });

  it("derives the landing decision from the authenticated tenant", () => {
    expect(landingSource).toContain("getServerSession(authOptions)");
    expect(landingSource).toContain("withTenant(db, practiceId");
    expect(landingSource).toContain("eq(practices.id, practiceId)");
    expect(landingSource).not.toContain("searchParams");
  });

  it("fails closed for every tenant mutation while recovery hold is active", () => {
    expect(trpcSource).toContain('type === "mutation"');
    expect(trpcSource).toContain("practices.recoveryHold");
    expect(trpcSource).toContain("ctx.session.user.recoveryHold === true");
    expect(trpcSource).toContain("protected data review mode");
  });
});
