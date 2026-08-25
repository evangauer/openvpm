import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { computeJourneyFunnel } from "@/lib/admin/journey-funnel";

const repoRoot = resolve(process.cwd(), "../..");
type SqlClient = ReturnType<typeof postgres>;
const describeWithPostgres =
  process.env.JOURNEY_FUNNEL_DB_INTEGRATION === "1"
    ? describe.sequential
    : describe.skip;

function runPnpm(args: string[], databaseUrl: string): void {
  const pnpmCliPath = process.env.PNPM_CLI_PATH?.trim();
  execFileSync(
    pnpmCliPath ? process.execPath : "pnpm",
    pnpmCliPath ? [pnpmCliPath, ...args] : args,
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
    },
  );
}

describeWithPostgres("journey funnel PostgreSQL and RLS contract", () => {
  it("uses canonical cross-tenant aggregates while keeping raw rows system-only", async () => {
    const adminUrl = process.env.DATABASE_URL?.trim();
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    const hostname = new URL(adminUrl).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      throw new Error("This test is restricted to disposable local PostgreSQL");
    }
    const appPassword = process.env.OPENPIMS_APP_DB_PASSWORD?.trim();
    if (!appPassword) throw new Error("OPENPIMS_APP_DB_PASSWORD is required");

    const databaseName = `openpims_journey_funnel_${randomUUID().replaceAll("-", "")}`;
    if (!/^openpims_journey_funnel_[a-f0-9]+$/.test(databaseName)) {
      throw new Error("unsafe disposable database name");
    }
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    databaseUrl.search = "";
    databaseUrl.hash = "";
    const appUrl = new URL(databaseUrl);
    appUrl.username = "openpims_app";
    appUrl.password = appPassword;

    const adminSql = postgres(adminUrl, { max: 1 });
    let ownerSql: ReturnType<typeof postgres> | undefined;
    let appSql: ReturnType<typeof postgres> | undefined;
    let databaseCreated = false;

    try {
      await adminSql.unsafe(`create database "${databaseName}"`);
      databaseCreated = true;
      runPnpm(
        ["--filter", "@openpims/db", "db:migrate"],
        databaseUrl.toString(),
      );
      runPnpm(["--filter", "@openpims/db", "db:rls"], databaseUrl.toString());

      ownerSql = postgres(databaseUrl.toString(), { max: 1 });
      appSql = postgres(appUrl.toString(), { max: 2 });
      const ownerDb = drizzle(ownerSql, { schema });
      const appDb = drizzle(appSql, { schema });

      const practice = (
        name: string,
        acquisition: Record<string, string>,
        extra: Record<string, unknown> = {},
      ) => ({
        id: randomUUID(),
        name,
        settings: { acquisition, ...extra },
      });
      const homepageA = practice("Synthetic homepage A", {
        source: "homepage_hero",
        medium: "product",
        campaign: "demo_dashboard",
      });
      const homepageB = practice("Synthetic homepage B", {
        source: "homepage_pricing",
        medium: "product",
        campaign: "demo_dashboard",
      });
      const privateToken = practice("Synthetic private token", {
        source: "clinic_private_name",
        campaign: "partner_private_name",
      });
      const olderSignup = practice("Synthetic older signup", {
        source: "direct",
        medium: "direct",
        campaign: "direct",
      });
      const deleted = {
        ...practice("Synthetic deleted", {
          source: "demo",
          medium: "product",
          campaign: "demo_login",
        }),
        deletedAt: new Date("2026-08-20T00:00:00.000Z"),
      };
      const excluded = practice(
        "Synthetic analytics excluded",
        { source: "demo", medium: "product", campaign: "demo_login" },
        { analyticsExcluded: true },
      );
      const practices = [
        homepageA,
        homepageB,
        privateToken,
        olderSignup,
        deleted,
        excluded,
      ];
      await ownerDb.insert(schema.practices).values(practices);

      type Milestone = typeof schema.practiceConversionMilestones.$inferInsert;
      const registered = (
        practiceId: string,
        occurredAt: string,
      ): Milestone => ({
        practiceId,
        milestone: "registered",
        occurredAt: new Date(occurredAt),
        evidenceSource: "practice_created",
        evidenceKey: `practice:${practiceId}`,
      });
      const activated = (
        practiceId: string,
        occurredAt: string,
      ): Milestone => ({
        practiceId,
        milestone: "activated",
        occurredAt: new Date(occurredAt),
        evidenceSource: "product_records",
        evidenceKey: `client:${randomUUID()}|appointment:${randomUUID()}`,
      });
      const stripe = (
        practiceId: string,
        milestone: "payment_method_collected" | "first_positive_payment",
        occurredAt: string,
      ): Milestone => ({
        practiceId,
        milestone,
        occurredAt: new Date(occurredAt),
        evidenceSource: "stripe_webhook",
        evidenceKey: `stripe:evt_${randomUUID()}`,
        ...(milestone === "first_positive_payment"
          ? { amountCents: 2500, currency: "usd" }
          : {}),
      });
      await ownerDb
        .insert(schema.practiceConversionMilestones)
        .values([
          registered(homepageA.id, "2026-08-01T12:00:00.000Z"),
          activated(homepageA.id, "2026-08-02T12:00:00.000Z"),
          stripe(
            homepageA.id,
            "payment_method_collected",
            "2026-08-03T12:00:00.000Z",
          ),
          stripe(
            homepageA.id,
            "first_positive_payment",
            "2026-08-04T12:00:00.000Z",
          ),
          registered(homepageB.id, "2026-08-05T12:00:00.000Z"),
          registered(privateToken.id, "2026-08-06T12:00:00.000Z"),
          activated(privateToken.id, "2026-08-07T12:00:00.000Z"),
          registered(olderSignup.id, "2026-07-01T12:00:00.000Z"),
          activated(olderSignup.id, "2026-08-10T12:00:00.000Z"),
          registered(deleted.id, "2026-08-08T12:00:00.000Z"),
          activated(deleted.id, "2026-08-09T12:00:00.000Z"),
          registered(excluded.id, "2026-08-08T12:00:00.000Z"),
          activated(excluded.id, "2026-08-09T12:00:00.000Z"),
        ]);

      const [identity] = await appSql<
        Array<{ currentUser: string; bypass: string | null }>
      >`
        select
          current_user as "currentUser",
          nullif(current_setting('app.rls_bypass', true), '') as bypass
      `;
      expect(identity).toEqual({ currentUser: "openpims_app", bypass: null });
      const [noContext] = await appSql<
        Array<{ practices: number; milestones: number }>
      >`
        select
          (select count(*)::int from practices) as practices,
          (select count(*)::int from practice_conversion_milestones) as milestones
      `;
      expect(noContext).toEqual({ practices: 0, milestones: 0 });

      const result = await computeJourneyFunnel(
        appDb,
        30,
        new Date("2026-08-25T12:00:00.000Z"),
      );

      expect(result.acquisitionOutcomes).toEqual([
        {
          source: "homepage",
          medium: "product",
          campaign: "demo_dashboard",
          registrations: 2,
          activated: 1,
          paymentMethodCollected: 1,
          firstPositivePayment: 1,
          activationRate: 0.5,
          paymentMethodRate: 0.5,
          positivePaymentRate: 0.5,
        },
        {
          source: "Other",
          medium: "Unknown",
          campaign: "Other",
          registrations: 1,
          activated: 1,
          paymentMethodCollected: 0,
          firstPositivePayment: 0,
          activationRate: 1,
          paymentMethodRate: 0,
          positivePaymentRate: 0,
        },
      ]);
      expect(result.periodActivity).toEqual({
        registrations: 3,
        activated: 3,
        paymentMethodCollected: 1,
        firstPositivePayment: 1,
      });

      await appSql.begin(async (tenantSql) => {
        const scopedSql = tenantSql as unknown as SqlClient;
        await scopedSql`select set_config('app.current_practice_id', ${homepageA.id}, true)`;
        const [tenantContext] = await scopedSql<
          Array<{ practices: number; milestones: number }>
        >`
          select
            (select count(*)::int from practices) as practices,
            (select count(*)::int from practice_conversion_milestones) as milestones
        `;
        expect(tenantContext).toEqual({ practices: 1, milestones: 0 });
      });
      const [afterReport] = await appSql<
        Array<{ practiceId: string | null; bypass: string | null }>
      >`
        select
          nullif(current_setting('app.current_practice_id', true), '') as "practiceId",
          nullif(current_setting('app.rls_bypass', true), '') as bypass
      `;
      expect(afterReport).toEqual({ practiceId: null, bypass: null });
    } finally {
      if (appSql) await appSql.end();
      if (ownerSql) await ownerSql.end();
      try {
        if (databaseCreated) {
          await adminSql.unsafe(
            `drop database if exists "${databaseName}" with (force)`,
          );
        }
      } finally {
        await adminSql.end();
      }
    }
  }, 120_000);
});
