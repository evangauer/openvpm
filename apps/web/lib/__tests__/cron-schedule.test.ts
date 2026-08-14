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
        "/api/cron/file-replicas",
        "/api/cron/usage-reconcile",
        "/api/cron/billing-lifecycle",
        "/api/cron/first-clinic-win",
        "/api/cron/setup-recovery",
        "/api/cron/wellness-billing",
        "/api/cron/rate-limit-cleanup",
        "/api/cron/auth-cleanup",
        "/api/cron/activation-digest",
        "/api/cron/sms-operations",
        "/api/cron/sms-provider-events",
        "/api/cron/conversion-reconcile",
        "/api/cron/prescription-expiry",
      ]),
    );

    expect(
      config.crons?.find((cron) => cron.path === "/api/cron/reminders")
        ?.schedule,
    ).toBe("0 * * * *");

    expect(
      config.crons?.find((cron) => cron.path === "/api/cron/setup-recovery")
        ?.schedule,
    ).toBe("0 15 * * *");

    expect(
      config.crons?.find((cron) => cron.path === "/api/cron/first-clinic-win")
        ?.schedule,
    ).toBe("17 * * * *");

    expect(
      config.crons?.find((cron) => cron.path === "/api/cron/sms-operations")
        ?.schedule,
    ).toBe("*/15 * * * *");

    const providerEventOperations = readFileSync(
      "lib/messaging/sms-provider-event-operations.ts",
      "utf8",
    );
    const staleMinutes = Number(
      providerEventOperations.match(
        /SMS_PROVIDER_EVENT_STALE_MINUTES\s*=\s*(\d+)/,
      )?.[1],
    );
    expect(staleMinutes).toBeGreaterThanOrEqual(15);

    expect(
      config.crons?.find(
        (cron) => cron.path === "/api/cron/sms-provider-events",
      )?.schedule,
    ).toBe("*/5 * * * *");
  });
});
