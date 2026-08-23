import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runBaseline } from "../../../../packages/db/baseline";
import { db } from "../../../../packages/db/client";
import { bookingPages } from "../../../../packages/db/schema/booking";
import { practices } from "../../../../packages/db/schema/practices";
import { appointmentTypes } from "../../../../packages/db/schema/scheduling";

const repoRoot = resolve(process.cwd(), "../..");
const describeWithBaselinePostgres =
  process.env.BASELINE_POSTCONDITION_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

describeWithBaselinePostgres(
  "baseline data-only migration PostgreSQL contract",
  () => {
    it("refuses exact and later cutoffs without a false ledger, then baselines compliant data once", async () => {
      const adminUrl = process.env.DATABASE_URL;
      if (!adminUrl) throw new Error("DATABASE_URL is required");

      const databaseName = `openpims_baseline_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_baseline_[a-f0-9]+$/.test(databaseName)) {
        throw new Error("unsafe disposable database name");
      }
      const databaseUrl = new URL(adminUrl);
      databaseUrl.pathname = `/${databaseName}`;
      databaseUrl.search = "";
      databaseUrl.hash = "";

      await db.execute(drizzleSql.raw(`create database "${databaseName}"`));

      try {
        execFileSync("pnpm", ["--filter", "@openpims/db", "db:migrate"], {
          cwd: repoRoot,
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          encoding: "utf8",
        });

        process.env.DATABASE_URL = databaseUrl.toString();
        await db.execute(drizzleSql.raw("drop schema drizzle cascade"));

        const [practice] = await db
          .insert(practices)
          .values({ name: "Synthetic baseline safety clinic" })
          .returning({ id: practices.id });
        if (!practice) throw new Error("failed to create synthetic practice");
        const [page] = await db
          .insert(bookingPages)
          .values({
            practiceId: practice.id,
            slug: `baseline-${randomUUID()}`,
            published: true,
            config: {},
          })
          .returning({ id: bookingPages.id });
        if (!page) throw new Error("failed to create synthetic booking page");

        const expectNoLedger = async () => {
          const rows = (await db.execute(
            drizzleSql.raw(
              "select to_regclass('drizzle.__drizzle_migrations')::text as ledger",
            ),
          )) as unknown as Array<{ ledger: string | null }>;
          expect(rows[0]?.ledger).toBeNull();
        };

        await expect(
          runBaseline({
            url: databaseUrl.toString(),
            through: "0052",
            apply: true,
            log: () => undefined,
          }),
        ).rejects.toThrow(
          "data-only migration 0052_booking_page_request_types has 1 active booking page row",
        );
        await expectNoLedger();

        await expect(
          runBaseline({
            url: databaseUrl.toString(),
            through: "0053",
            apply: true,
            log: () => undefined,
          }),
        ).rejects.toThrow(
          "Cannot baseline through 0053_invoice_line_taxability",
        );
        await expectNoLedger();

        for (const invalidConfig of [
          { bookableTypeIds: "not-an-array" },
          { bookableTypeIds: ["not-a-uuid"] },
          { bookableTypeIds: [randomUUID()] },
        ]) {
          await db
            .update(bookingPages)
            .set({ config: invalidConfig, published: true })
            .where(eq(bookingPages.id, page.id));
          await expect(
            runBaseline({
              url: databaseUrl.toString(),
              through: "0052",
              apply: true,
              log: () => undefined,
            }),
          ).rejects.toThrow(
            "data-only migration 0052_booking_page_request_types has 1 active booking page row",
          );
          await expectNoLedger();
        }

        const [appointmentType] = await db
          .insert(appointmentTypes)
          .values({
            practiceId: practice.id,
            name: "Synthetic viable request type",
          })
          .returning({ id: appointmentTypes.id });
        if (!appointmentType) {
          throw new Error("failed to create synthetic appointment type");
        }
        await db
          .update(bookingPages)
          .set({
            config: { bookableTypeIds: [appointmentType.id] },
            published: true,
          })
          .where(eq(bookingPages.id, page.id));

        await expect(
          runBaseline({
            url: databaseUrl.toString(),
            through: "0052",
            apply: true,
            log: () => undefined,
          }),
        ).resolves.toBeUndefined();

        const ledgerRows = (await db.execute(
          drizzleSql.raw(
            'select count(*)::int as count from drizzle."__drizzle_migrations"',
          ),
        )) as unknown as Array<{ count: number }>;
        expect(ledgerRows[0]?.count).toBe(53);

        await expect(
          runBaseline({
            url: databaseUrl.toString(),
            through: "0052",
            apply: true,
            log: () => undefined,
          }),
        ).rejects.toThrow("A migration ledger already exists with 53 row(s)");
      } finally {
        process.env.DATABASE_URL = adminUrl;
        await db.execute(
          drizzleSql.raw(
            `drop database if exists "${databaseName}" with (force)`,
          ),
        );
      }
    }, 60_000);
  },
);
