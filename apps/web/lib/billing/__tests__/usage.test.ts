import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  currentPeriodMonth,
  crossesAbuseThreshold,
  ABUSE_ALERT_THRESHOLDS,
  meterIdentifierForUsageRecord,
} from "../usage";

describe("currentPeriodMonth", () => {
  it("formats the billing period as YYYY-MM (UTC)", () => {
    expect(currentPeriodMonth(new Date("2026-06-07T12:00:00Z"))).toBe("2026-06");
    expect(currentPeriodMonth(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01");
    expect(currentPeriodMonth(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });
});

describe("usage query scoping", () => {
  const source = readFileSync(new URL("../usage.ts", import.meta.url), "utf8");

  it("keeps metering and reconciliation scoped to active rows", () => {
    const activePracticeGuard = source.indexOf("const [activePractice]");
    const usageInsert = source.indexOf("tx.insert(usageRecords)");
    expect(activePracticeGuard).toBeGreaterThanOrEqual(0);
    expect(usageInsert).toBeGreaterThan(activePracticeGuard);
    expect(source).toMatch(
      /id: practices\.id,\s*recoveryHold: practices\.recoveryHold,[\s\S]+?where\(\s*and\(\s*eq\(practices\.id, opts\.practiceId\),\s*isNull\(practices\.deletedAt\)\s*\)\s*\)/s
    );
    expect(source).toContain("if (!activePractice) return;");
    expect(source).toMatch(
      /eq\(practices\.id, opts\.practiceId\),\s*isNull\(practices\.deletedAt\)/s
    );
    expect(source).toContain("eq(practices.recoveryHold, false)");
    expect(source).toContain('.for("share", { of: practices })');
    expect(source).toMatch(
      /eq\(usageRecords\.id, opts\.usageRecordId\),\s*isNull\(usageRecords\.deletedAt\)/s
    );
    expect(source).toMatch(
      /isNull\(usageRecords\.stripeMeteredAt\),\s*isNull\(usageRecords\.deletedAt\)/s
    );
    expect(source).toMatch(
      /eq\(usageRecords\.periodMonth, periodMonth\),\s*isNull\(usageRecords\.deletedAt\)/s
    );
  });
});

describe("meterIdentifierForUsageRecord", () => {
  it("uses a stable identifier derived from the usage row id", () => {
    expect(meterIdentifierForUsageRecord("usage-row-1")).toBe("usage:usage-row-1");
  });
});

describe("crossesAbuseThreshold", () => {
  const sms = ABUSE_ALERT_THRESHOLDS.sms;
  const ai = ABUSE_ALERT_THRESHOLDS.ai_run;

  it("fires exactly once on the insert that crosses the boundary", () => {
    expect(crossesAbuseThreshold("sms", sms - 1, sms)).toBe(true);
    expect(crossesAbuseThreshold("sms", sms - 5, sms + 3)).toBe(true);
    expect(crossesAbuseThreshold("ai_run", ai - 1, ai)).toBe(true);
  });

  it("does not fire below the threshold", () => {
    expect(crossesAbuseThreshold("sms", 0, 1)).toBe(false);
    expect(crossesAbuseThreshold("sms", sms - 10, sms - 1)).toBe(false);
  });

  it("does not re-fire once already past the threshold", () => {
    expect(crossesAbuseThreshold("sms", sms, sms + 1)).toBe(false);
    expect(crossesAbuseThreshold("ai_run", ai + 5, ai + 6)).toBe(false);
  });
});
