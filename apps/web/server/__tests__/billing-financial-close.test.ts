import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/routers/billing.ts", "utf8");

describe("billing financial close contract", () => {
  it("exposes statements and immutable, admin-only day close", () => {
    expect(source).toContain("financialDayStatement: protectedProcedure");
    expect(source).toContain("listFinancialCloses: protectedProcedure");
    expect(source).toContain("closeFinancialDay: billingAdminProcedure");
    expect(source).toContain("CLOSE:${input.businessDate}");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("summary.unreconciledCount > 0");
    expect(source).toContain("This clinic day has not ended");
    expect(source).toContain(".insert(financialCloses)");
    expect(source).not.toContain(".update(financialCloses)");
    expect(source).not.toContain(".delete(financialCloses)");
  });

  it("serializes dispute-window timestamps across bundled runtimes", () => {
    expect(source).toContain(
      "const cutoffAtIso = summary.cutoffAt.toISOString()",
    );
    expect(source).toContain("${cutoffAtIso}::timestamptz");
    expect(source).not.toContain("${summary.cutoffAt}");
  });
});
