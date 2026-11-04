import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { Database } from "@openpims/db/client";
import * as schema from "@openpims/db";
import { withTenant } from "@/lib/tenant-db";
import {
  appointmentReminderDedupeKey,
  claimAppointmentReminderCommunication,
} from "@/lib/messaging/appointment-reminder";

const integration =
  process.env.APPOINTMENT_REMINDER_CLAIM_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

const CLAIMERS = 16;
const ROUNDS = 3;

type Claimer = { channel: "sms" | "email"; source: "staff" | "automated" };

/** Every combination of channel and source, repeated to CLAIMERS. */
const MIXED: Claimer[] = Array.from({ length: CLAIMERS }, (_, i) => ({
  channel: i % 2 === 0 ? "sms" : "email",
  source: i % 4 < 2 ? "staff" : "automated",
}));
const AUTOMATED_ONLY: Claimer[] = MIXED.map((claimer) => ({
  ...claimer,
  source: "automated",
}));

type ExistingRow = {
  channel: "sms" | "email";
  status: "pending" | "sent" | "failed";
  ageMinutes: number;
  reminderAttempt: number | null;
  reminderAutomatedAttempts?: number | null;
  reminderOutcome?: "staff_failure" | "automated_failure" | "outcome_unknown";
  reservedSmsAttempt?: boolean;
};

type Scenario = {
  name: string;
  existing: ExistingRow | null;
  claimers: Claimer[];
  /** Exact number of winners expected (never more than one). */
  winners: 0 | 1;
  winnerChannel?: "sms" | "email";
  winnerSource?: "staff" | "automated";
  attemptAfterClaim?: number;
};

const SCENARIOS: Scenario[] = [
  { name: "new row", existing: null, claimers: MIXED, winners: 1, attemptAfterClaim: 1 },
  {
    name: "live pending",
    existing: { channel: "email", status: "pending", ageMinutes: 1, reminderAttempt: 1 },
    claimers: MIXED,
    winners: 0,
  },
  {
    name: "stale pending email",
    existing: { channel: "email", status: "pending", ageMinutes: 20, reminderAttempt: 1 },
    claimers: MIXED,
    winners: 1,
    // Never handed to SMS: the abandoned email may have gone out.
    winnerChannel: "email",
    // A reclaimed abandoned claim keeps its attempt (and idempotency key).
    attemptAfterClaim: 1,
  },
  {
    name: "stale pending SMS with no reserved attempt",
    existing: { channel: "sms", status: "pending", ageMinutes: 20, reminderAttempt: 1 },
    claimers: MIXED,
    winners: 1,
    winnerChannel: "sms",
    attemptAfterClaim: 1,
  },
  {
    name: "stale pending SMS with a reserved attempt",
    existing: {
      channel: "sms",
      status: "pending",
      ageMinutes: 120,
      reminderAttempt: 1,
      reservedSmsAttempt: true,
    },
    claimers: MIXED,
    winners: 0,
  },
  {
    // The reviewer's case: an old failed row reset to pending must not look
    // abandoned to the SMS stale-recovery path.
    name: "failed (staff), created long ago",
    existing: {
      channel: "email",
      status: "failed",
      ageMinutes: 180,
      reminderAttempt: 1,
      reminderAutomatedAttempts: 0,
      reminderOutcome: "staff_failure",
    },
    claimers: MIXED,
    winners: 1,
    attemptAfterClaim: 2,
  },
  {
    name: "failed SMS (staff) with a reserved attempt",
    existing: {
      channel: "sms",
      status: "failed",
      ageMinutes: 180,
      reminderAttempt: 1,
      reminderAutomatedAttempts: 0,
      reminderOutcome: "staff_failure",
      reservedSmsAttempt: true,
    },
    claimers: MIXED,
    winners: 1,
    attemptAfterClaim: 2,
  },
  {
    name: "failed (cron) before the retry window, sweep only",
    existing: {
      channel: "email",
      status: "failed",
      ageMinutes: 30,
      reminderAttempt: 1,
      reminderAutomatedAttempts: 1,
      reminderOutcome: "automated_failure",
    },
    claimers: AUTOMATED_ONLY,
    winners: 0,
  },
  {
    name: "failed (cron) before the retry window, staff and sweep",
    existing: {
      channel: "email",
      status: "failed",
      ageMinutes: 30,
      reminderAttempt: 1,
      reminderAutomatedAttempts: 1,
      reminderOutcome: "automated_failure",
    },
    claimers: MIXED,
    winners: 1,
    winnerSource: "staff",
    attemptAfterClaim: 2,
  },
  {
    name: "failed (cron) after the retry window",
    existing: {
      channel: "email",
      status: "failed",
      ageMinutes: 90,
      reminderAttempt: 1,
      reminderAutomatedAttempts: 1,
      reminderOutcome: "automated_failure",
    },
    claimers: AUTOMATED_ONLY,
    winners: 1,
    attemptAfterClaim: 2,
  },
  {
    name: "failed (cron) after its one retry",
    existing: {
      channel: "email",
      status: "failed",
      ageMinutes: 90,
      reminderAttempt: 2,
      reminderAutomatedAttempts: 2,
      reminderOutcome: "automated_failure",
    },
    claimers: AUTOMATED_ONLY,
    winners: 0,
  },
  {
    name: "sent",
    existing: { channel: "email", status: "sent", ageMinutes: 180, reminderAttempt: 1 },
    claimers: MIXED,
    winners: 0,
  },
  {
    name: "email outcome unknown",
    existing: {
      channel: "email",
      status: "pending",
      ageMinutes: 180,
      reminderAttempt: 1,
      reminderOutcome: "outcome_unknown",
    },
    claimers: MIXED,
    winners: 0,
  },
  {
    name: "SMS outcome unknown",
    existing: {
      channel: "sms",
      status: "pending",
      ageMinutes: 180,
      reminderAttempt: 1,
      reminderOutcome: "outcome_unknown",
      reservedSmsAttempt: true,
    },
    claimers: MIXED,
    winners: 0,
  },
  {
    name: "failed before retries existed",
    existing: { channel: "email", status: "failed", ageMinutes: 180, reminderAttempt: null },
    claimers: MIXED,
    winners: 0,
  },
  {
    name: "stale pending email before retries existed",
    existing: { channel: "email", status: "pending", ageMinutes: 180, reminderAttempt: null },
    claimers: MIXED,
    winners: 0,
  },
];

integration("appointment reminder claim under PostgreSQL concurrency", () => {
  it(
    `lets at most one of ${CLAIMERS} concurrent claimers win each reminder`,
    async () => {
      const adminUrl = process.env.DATABASE_URL;
      if (!adminUrl) throw new Error("DATABASE_URL is required");
      const databaseName = `openpims_reminder_claim_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_reminder_claim_[a-f0-9]+$/.test(databaseName))
        throw new Error("unsafe database name");
      const databaseUrl = new URL(adminUrl);
      databaseUrl.pathname = `/${databaseName}`;
      databaseUrl.search = "";
      databaseUrl.hash = "";
      const admin = postgres(adminUrl, { max: 1 });
      let owner: ReturnType<typeof postgres> | undefined;
      let app: ReturnType<typeof postgres> | undefined;
      await admin.unsafe(`create database "${databaseName}"`);
      try {
        for (const command of ["db:migrate", "db:rls"]) {
          execFileSync("pnpm", ["--filter", "@openpims/db", command], {
            cwd: resolve(process.cwd(), "../.."),
            env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
            stdio: "pipe",
            timeout: 90_000,
          });
        }
        owner = postgres(databaseUrl.toString(), { max: 1 });
        const ownerDb = drizzle(owner, { schema });
        // One pooled connection per claimer so every claim really runs
        // concurrently, each as the least-privilege role under RLS.
        app = postgres(databaseUrl.toString(), {
          max: CLAIMERS + 2,
          connection: { role: "openpims_app" },
        });
        const appDb = drizzle(app, { schema }) as unknown as Database;

        const [practice] = await ownerDb
          .insert(schema.practices)
          .values({ name: "Synthetic Reminder Clinic" })
          .returning();
        const [client] = await ownerDb
          .insert(schema.clients)
          .values({
            practiceId: practice!.id,
            firstName: "Synthetic",
            lastName: "Client",
          })
          .returning();
        const practiceId = practice!.id;
        const clientId = client!.id;

        const results: string[] = [];
        for (const scenario of SCENARIOS) {
          for (let round = 0; round < ROUNDS; round++) {
            const appointmentId = randomUUID();
            const startTime = new Date(Date.UTC(2030, 0, 1, 15, round));
            const dedupeKey = appointmentReminderDedupeKey({
              id: appointmentId,
              startTime,
            });

            if (scenario.existing) {
              const existing = scenario.existing;
              const age = sql`now() - make_interval(mins => ${existing.ageMinutes})`;
              const [row] = await ownerDb
                .insert(schema.communications)
                .values({
                  practiceId,
                  clientId,
                  channel: existing.channel,
                  direction: "outbound",
                  subject: "Appointment Reminder",
                  content: `seed ${scenario.name}`,
                  status: existing.status,
                  dedupeKey,
                  reminderAttempt: existing.reminderAttempt,
                  reminderAutomatedAttempts:
                    existing.reminderAttempt === null
                      ? null
                      : (existing.reminderAutomatedAttempts ?? 0),
                  reminderOutcome: existing.reminderOutcome ?? null,
                  createdAt: age,
                  updatedAt: age,
                })
                .returning({ id: schema.communications.id });
              if (existing.reservedSmsAttempt) {
                const body = "Reminder: synthetic appointment.";
                await ownerDb.insert(schema.smsSendAttempts).values({
                  practiceId,
                  clientId,
                  communicationId: row!.id,
                  source: "appointment_reminder",
                  sourceId: dedupeKey,
                  idempotencyKey: `sms:${dedupeKey}`,
                  destinationE164: "+15555550100",
                  registeredDisplayName: "Synthetic Reminder Clinic",
                  body,
                  bodySha256: createHash("sha256").update(body).digest("hex"),
                  provider: "console",
                });
              }
            }

            // Open every claimer's transaction first, then release them
            // together so all claims contend for the same row at once.
            let release!: () => void;
            const barrier = new Promise<void>((done) => (release = done));
            let entered = 0;
            const claims = scenario.claimers.map((claimer) =>
              withTenant(appDb, practiceId, async (tx) => {
                if (++entered === scenario.claimers.length) release();
                await barrier;
                const claim = await claimAppointmentReminderCommunication(tx, {
                  practiceId,
                  appointmentId,
                  clientId,
                  channel: claimer.channel,
                  patientName: "Miso",
                  startTime,
                  source: claimer.source,
                });
                return claim ? { ...claim, claimer } : null;
              }),
            );
            const winners = (await Promise.all(claims)).filter(
              (claim) => claim !== null,
            );

            const label = `${scenario.name} (round ${round + 1})`;
            expect(winners.length, label).toBeLessThanOrEqual(1);
            expect(winners.length, label).toBe(scenario.winners);
            const [winner] = winners;
            if (winner) {
              if (scenario.winnerChannel) {
                expect(winner.claimer.channel, label).toBe(scenario.winnerChannel);
              }
              if (scenario.winnerSource) {
                expect(winner.claimer.source, label).toBe(scenario.winnerSource);
              }
              const [row] = await ownerDb
                .select({
                  status: schema.communications.status,
                  channel: schema.communications.channel,
                  reminderAttempt: schema.communications.reminderAttempt,
                  reminderOutcome: schema.communications.reminderOutcome,
                  fresh: sql<boolean>`${schema.communications.updatedAt} > now() - interval '1 minute'`,
                })
                .from(schema.communications)
                .where(eq(schema.communications.dedupeKey, dedupeKey));
              expect(row, label).toMatchObject({
                status: "pending",
                channel: winner.claimer.channel,
                reminderAttempt: scenario.attemptAfterClaim,
                reminderOutcome: null,
                fresh: true,
              });
              expect(winner.attempt, label).toBe(scenario.attemptAfterClaim);
            }
            results.push(
              `${label}: ${winners.length} of ${scenario.claimers.length} claimed`,
            );
          }
        }
        console.log(results.join("\n"));
      } finally {
        await app?.end({ timeout: 5 });
        await owner?.end({ timeout: 5 });
        await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
        await admin.end({ timeout: 5 });
      }
    },
    240_000,
  );
});
