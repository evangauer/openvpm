import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Vercel cron schedule", () => {
  it("schedules every production cron route", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as {
      crons?: Array<{ path: string; schedule: string }>;
    };
    const paths = new Set(config.crons?.map((cron) => cron.path));

    expect(paths).toEqual(
      new Set([
        "/api/cron/reminders",
        "/api/cron/backup",
        "/api/cron/usage-reconcile",
        "/api/cron/billing-lifecycle",
        "/api/cron/wellness-billing",
        "/api/cron/rate-limit-cleanup",
        "/api/cron/auth-cleanup",
        "/api/cron/activation-digest",
        "/api/cron/prescription-expiry",
      ]),
    );

    expect(
      config.crons?.find((cron) => cron.path === "/api/cron/reminders")
        ?.schedule,
    ).toBe("0 * * * *");
  });
});
