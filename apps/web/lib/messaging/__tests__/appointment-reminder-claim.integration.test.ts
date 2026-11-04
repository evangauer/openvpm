import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@openpims/db/client";
import * as schema from "@openpims/db";
import { withTenant } from "@/lib/tenant-db";
import {
  type AppointmentReminderClaim,
  EMAIL_REMINDER_KEY_REUSE_WINDOW_MS,
  STALE_EMAIL_REMINDER_CLAIM_MS,
  appointmentReminderDedupeKey,
  appointmentReminderEmailIdempotencyKey,
  appointmentReminderSmsIdempotencyKey,
  claimAppointmentReminderCommunication,
  recordAppointmentReminderOutcome,
  sendClaimedAppointmentReminderEmail,
} from "@/lib/messaging/appointment-reminder";

const integration =
  process.env.APPOINTMENT_REMINDER_CLAIM_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

const CLAIMERS = 16;
const ROUNDS = 3;
const KEY_WINDOW_MINUTES = EMAIL_REMINDER_KEY_REUSE_WINDOW_MS / 60_000;

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
  /** When the attempt was first claimed; defaults to ageMinutes. */
  attemptStartedMinutesAgo?: number | null;
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
  /** Row state expected when nobody wins. */
  rowAfterNoWinner?: {
    status: "pending" | "sent" | "failed";
    reminderAttempt: number | null;
    reminderOutcome: string | null;
  };
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
    name: "stale pending email past the key window",
    existing: {
      channel: "email",
      status: "pending",
      ageMinutes: KEY_WINDOW_MINUTES + 5,
      reminderAttempt: 1,
    },
    claimers: MIXED,
    winners: 0,
    // The key may have expired: shown as "Delivery unknown", never resent.
    rowAfterNoWinner: {
      status: "pending",
      reminderAttempt: 1,
      reminderOutcome: "outcome_unknown",
    },
  },
  {
    name: "email outcome unknown within the key window",
    existing: {
      channel: "email",
      status: "pending",
      ageMinutes: 1,
      reminderAttempt: 1,
      reminderOutcome: "outcome_unknown",
      attemptStartedMinutesAgo: KEY_WINDOW_MINUTES - 5,
    },
    claimers: MIXED,
    winners: 1,
    // Resent only as email, under the same attempt (and idempotency key).
    winnerChannel: "email",
    attemptAfterClaim: 1,
  },
  {
    name: "email outcome unknown on a retried attempt",
    existing: {
      channel: "email",
      status: "pending",
      ageMinutes: 30,
      reminderAttempt: 2,
      reminderAutomatedAttempts: 2,
      reminderOutcome: "outcome_unknown",
    },
    claimers: AUTOMATED_ONLY,
    winners: 1,
    winnerChannel: "email",
    attemptAfterClaim: 2,
  },
  {
    name: "email outcome unknown past the key window",
    existing: {
      channel: "email",
      status: "pending",
      ageMinutes: 60,
      reminderAttempt: 1,
      reminderOutcome: "outcome_unknown",
      attemptStartedMinutesAgo: KEY_WINDOW_MINUTES + 5,
    },
    claimers: MIXED,
    winners: 0,
    rowAfterNoWinner: {
      status: "pending",
      reminderAttempt: 1,
      reminderOutcome: "outcome_unknown",
    },
  },
  {
    name: "email outcome unknown with no attempt clock",
    existing: {
      channel: "email",
      status: "pending",
      ageMinutes: 60,
      reminderAttempt: 1,
      reminderOutcome: "outcome_unknown",
      attemptStartedMinutesAgo: null,
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

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Start every claimer's transaction, then release all claims at once. */
async function concurrentClaims(
  appDb: Database,
  options: {
    practiceId: string;
    appointmentId: string;
    clientId: string;
    startTime: Date;
    claimers: Claimer[];
  },
) {
  let release!: () => void;
  const barrier = new Promise<void>((done) => (release = done));
  let entered = 0;
  const claims = options.claimers.map((claimer) =>
    withTenant(appDb, options.practiceId, async (tx) => {
      if (++entered === options.claimers.length) release();
      await barrier;
      const claim = await claimAppointmentReminderCommunication(tx, {
        practiceId: options.practiceId,
        appointmentId: options.appointmentId,
        clientId: options.clientId,
        channel: claimer.channel,
        patientName: "Miso",
        startTime: options.startTime,
        source: claimer.source,
      });
      return claim ? { ...claim, claimer } : null;
    }),
  );
  return (await Promise.all(claims)).filter((claim) => claim !== null);
}

/**
 * Drive the real email client (and the real Resend SDK) against provider
 * failures that leave the send unconfirmed, and check that each one is
 * retried under the same idempotency key by exactly one claimer, never under
 * a new attempt key, and not at all once the key may have expired.
 */
async function unknownEmailLifecycle(
  ownerDb: Db,
  appDb: Database,
  practiceId: string,
  clientId: string,
) {
  const appointment = {
    id: randomUUID(),
    startTime: new Date(Date.UTC(2030, 0, 2, 15)),
  };
  const dedupeKey = appointmentReminderDedupeKey(appointment);
  const seenKeys: string[] = [];
  const responses: Array<() => Response> = [
    () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        }),
      });
    },
    () =>
      new Response("<html><body>502 Bad Gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response(
        JSON.stringify({
          statusCode: 500,
          name: "internal_server_error",
          message: "An unexpected error occurred.",
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    () =>
      new Response('{"id":"4ef9a417-02e9', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ];
  vi.stubEnv("RESEND_API_KEY", "re_integration_test");
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      const next = responses.shift();
      if (!next) throw new Error("unexpected provider call");
      return next();
    }),
  );
  vi.resetModules();
  const { sendAppointmentReminder } = await import("@/lib/email");

  const [first] = await concurrentClaims(appDb, {
    practiceId,
    clientId,
    appointmentId: appointment.id,
    startTime: appointment.startTime,
    claimers: [{ channel: "email", source: "staff" }],
  });
  expect(first?.attempt).toBe(1);
  let claim = first!;
  const failures = responses.length;
  for (let i = 0; i < failures; i++) {
    const result = await sendAppointmentReminder({
      to: "client@example.com",
      clientName: "Synthetic Client",
      patientName: "Miso",
      appointmentDate: "January 2",
      appointmentTime: "3:00 PM",
      practiceName: "Synthetic Reminder Clinic",
      idempotencyKey: appointmentReminderEmailIdempotencyKey(
        appointment,
        claim.attempt,
      ),
    });
    expect(result, `provider failure ${i + 1}`).toMatchObject({
      success: false,
      outcome: "outcome_unknown",
    });
    await withTenant(appDb, practiceId, (tx) =>
      recordAppointmentReminderOutcome(tx, {
        practiceId,
        claim,
        channel: "email",
        result: "unknown",
        source: "staff",
        content: "Appointment reminder delivery unknown",
      }),
    );

    const winners = await concurrentClaims(appDb, {
      practiceId,
      clientId,
      appointmentId: appointment.id,
      startTime: appointment.startTime,
      claimers: MIXED,
    });
    expect(winners, `retry after failure ${i + 1}`).toHaveLength(1);
    expect(winners[0]!.claimer.channel).toBe("email");
    expect(winners[0]!.attempt).toBe(1);
    claim = winners[0]!;
  }
  // Every provider call reused the first attempt's key.
  expect(seenKeys).toEqual(
    Array(failures).fill(appointmentReminderEmailIdempotencyKey(appointment, 1)),
  );

  // Unconfirmed again, and now past the window in which the key is honored.
  await withTenant(appDb, practiceId, (tx) =>
    recordAppointmentReminderOutcome(tx, {
      practiceId,
      claim,
      channel: "email",
      result: "unknown",
      source: "staff",
      content: "Appointment reminder delivery unknown",
    }),
  );
  await ownerDb
    .update(schema.communications)
    .set({
      reminderAttemptStartedAt: sql`now() - make_interval(mins => ${KEY_WINDOW_MINUTES + 1})`,
    })
    .where(eq(schema.communications.dedupeKey, dedupeKey));
  const lateWinners = await concurrentClaims(appDb, {
    practiceId,
    clientId,
    appointmentId: appointment.id,
    startTime: appointment.startTime,
    claimers: MIXED,
  });
  expect(lateWinners).toHaveLength(0);
  const [row] = await ownerDb
    .select({
      status: schema.communications.status,
      reminderAttempt: schema.communications.reminderAttempt,
      reminderOutcome: schema.communications.reminderOutcome,
    })
    .from(schema.communications)
    .where(eq(schema.communications.dedupeKey, dedupeKey));
  expect(row).toEqual({
    status: "pending",
    reminderAttempt: 1,
    reminderOutcome: "outcome_unknown",
  });
  return `unknown email lifecycle: ${failures} unconfirmed sends retried under one key; none after the key window`;
}

type ReminderFixture = {
  ownerDb: Db;
  appDb: Database;
  practiceId: string;
  clientId: string;
};
type Appointment = { id: string; startTime: Date };

function newAppointment(hour: number): Appointment {
  return { id: randomUUID(), startTime: new Date(Date.UTC(2030, 0, 3, hour)) };
}

function claimAll(f: ReminderFixture, appointment: Appointment, claimers: Claimer[]) {
  return concurrentClaims(f.appDb, {
    practiceId: f.practiceId,
    clientId: f.clientId,
    appointmentId: appointment.id,
    startTime: appointment.startTime,
    claimers,
  });
}

async function claimOnce(f: ReminderFixture, appointment: Appointment, claimer: Claimer) {
  const [claim] = await claimAll(f, appointment, [claimer]);
  return claim ?? null;
}

async function reminderRow(f: ReminderFixture, appointment: Appointment) {
  const [row] = await f.ownerDb
    .select({
      status: schema.communications.status,
      reminderAttempt: schema.communications.reminderAttempt,
      reminderOutcome: schema.communications.reminderOutcome,
    })
    .from(schema.communications)
    .where(
      eq(schema.communications.dedupeKey, appointmentReminderDedupeKey(appointment)),
    );
  return row;
}

function record(
  f: ReminderFixture,
  claim: AppointmentReminderClaim,
  result: "sent" | "failed" | "unknown",
  source: "staff" | "automated",
  options: { channel?: "sms" | "email"; providerMessageId?: string } = {},
) {
  return withTenant(f.appDb, f.practiceId, (tx) =>
    recordAppointmentReminderOutcome(tx, {
      practiceId: f.practiceId,
      claim,
      channel: options.channel ?? "email",
      result,
      source,
      content: `Appointment reminder ${result}`,
      providerMessageId: options.providerMessageId,
    }),
  );
}

/** Real email client and Resend SDK behind a scripted fetch. */
async function scriptedEmailProvider(
  responses: Array<() => Response | Promise<Response>>,
) {
  const seenKeys: string[] = [];
  vi.stubEnv("RESEND_API_KEY", "re_integration_test");
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "false");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      seenKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      const next = responses.shift();
      if (!next) throw new Error("unexpected provider call");
      return next();
    }),
  );
  vi.resetModules();
  const { sendAppointmentReminder } = await import("@/lib/email");
  return { seenKeys, sendAppointmentReminder };
}

type SendReminderEmail = (typeof import("@/lib/email"))["sendAppointmentReminder"];

function fencedSend(
  f: ReminderFixture,
  claim: AppointmentReminderClaim,
  sendAppointmentReminder: SendReminderEmail,
  appointment: Appointment,
) {
  return sendClaimedAppointmentReminderEmail(
    (fn) => withTenant(f.appDb, f.practiceId, fn),
    { practiceId: f.practiceId, claim },
    () =>
      sendAppointmentReminder({
        to: "client@example.com",
        clientName: "Synthetic Client",
        patientName: "Miso",
        appointmentDate: "Thursday, January 3, 2030",
        appointmentTime: "3:00 PM",
        practiceName: "Synthetic Reminder Clinic",
        idempotencyKey: appointmentReminderEmailIdempotencyKey(
          appointment,
          claim.attempt,
        ),
      }),
  );
}

const acceptedEmail = (id: string) => () =>
  new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const rateLimited = () =>
  new Response(
    JSON.stringify({
      statusCode: 429,
      name: "rate_limit_exceeded",
      message: "Too many requests",
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );

/**
 * After an unconfirmed email, a redispatch stopped by something that says
 * nothing about the first send (the hourly sending quota, a recovery pause, a
 * recipient that is no longer eligible) must stay "Delivery unknown" under
 * the same attempt. Recording a failure would let the next claim start
 * attempt 2 under a new key and email the client twice.
 */
async function redispatchFailuresNeverAdvanceTheAttempt(f: ReminderFixture) {
  const appointment = newAppointment(15);
  const { seenKeys, sendAppointmentReminder } = await scriptedEmailProvider([
    () => {
      throw new TypeError("fetch failed");
    },
    acceptedEmail("email-finally-confirmed"),
  ]);
  const first = (await claimOnce(f, appointment, { channel: "email", source: "staff" }))!;
  expect(first).toMatchObject({ attempt: 1, redispatch: false });
  await expect(
    fencedSend(f, first, sendAppointmentReminder, appointment),
  ).resolves.toMatchObject({
    status: "called",
    result: { outcome: "outcome_unknown" },
  });
  await record(f, first, "unknown", "staff");

  // Each caller records these stops as "failed" before any provider call.
  const stops: Array<"staff" | "automated"> = ["staff", "automated", "staff", "automated"];
  for (const [i, source] of stops.entries()) {
    const winners = await claimAll(f, appointment, MIXED);
    expect(winners, `redispatch ${i + 1}`).toHaveLength(1);
    expect(winners[0]).toMatchObject({ attempt: 1, redispatch: true });
    await record(f, winners[0]!, "failed", source);
    expect(await reminderRow(f, appointment), `after stop ${i + 1}`).toEqual({
      status: "pending",
      reminderAttempt: 1,
      reminderOutcome: "outcome_unknown",
    });
  }

  const [last] = await claimAll(f, appointment, MIXED);
  await expect(
    fencedSend(f, last!, sendAppointmentReminder, appointment),
  ).resolves.toMatchObject({ status: "called", result: { success: true } });
  await record(f, last!, "sent", "staff", {
    providerMessageId: "email-finally-confirmed",
  });
  expect(await reminderRow(f, appointment)).toEqual({
    status: "sent",
    reminderAttempt: 1,
    reminderOutcome: null,
  });
  expect(seenKeys).toEqual(
    Array(2).fill(appointmentReminderEmailIdempotencyKey(appointment, 1)),
  );
  return `redispatch stops: ${stops.length} non-provider stops after an unknown kept attempt 1; no attempt-2 key`;
}

/** A 429 is never a definite failure: every retry reuses the first key. */
async function rateLimitedEmailRetriesUnderOneKey(f: ReminderFixture) {
  const appointment = newAppointment(16);
  const { seenKeys, sendAppointmentReminder } = await scriptedEmailProvider([
    rateLimited,
    rateLimited,
    rateLimited,
    acceptedEmail("email-after-429"),
  ]);
  let claim = (await claimOnce(f, appointment, {
    channel: "email",
    source: "automated",
  }))!;
  for (let i = 0; i < 3; i++) {
    await expect(
      fencedSend(f, claim, sendAppointmentReminder, appointment),
      `429 ${i + 1}`,
    ).resolves.toMatchObject({
      status: "called",
      result: { success: false, outcome: "outcome_unknown" },
    });
    await record(f, claim, "unknown", "automated");
    const winners = await claimAll(f, appointment, MIXED);
    expect(winners, `retry after 429 ${i + 1}`).toHaveLength(1);
    expect(winners[0]!.attempt).toBe(1);
    claim = winners[0]!;
  }
  await expect(
    fencedSend(f, claim, sendAppointmentReminder, appointment),
  ).resolves.toMatchObject({ status: "called", result: { success: true } });
  await record(f, claim, "sent", "automated", {
    providerMessageId: "email-after-429",
  });
  expect(seenKeys).toEqual(
    Array(4).fill(appointmentReminderEmailIdempotencyKey(appointment, 1)),
  );
  expect((await reminderRow(f, appointment))?.status).toBe("sent");
  return "429 chain: 3 rate-limited sends retried under one key, then confirmed";
}

/**
 * The provider accepts the email, then the connection holding the send
 * transaction dies before COMMIT. That is an unknown outcome, retried only
 * under the same key.
 */
async function commitFailureAfterAcceptanceIsUnknown(f: ReminderFixture) {
  const appointment = newAppointment(17);
  const { seenKeys, sendAppointmentReminder } = await scriptedEmailProvider([
    async () => {
      // Kill the backend holding the reminder row lock mid-send.
      const killed = await f.ownerDb.execute<{ killed: boolean }>(sql`
        select pg_terminate_backend(l.pid) as killed
        from pg_locks l
        join pg_class c on c.oid = l.relation
        where c.relname = 'communications'
          and l.mode = 'RowShareLock'
          and l.pid <> pg_backend_pid()
      `);
      expect(killed.length).toBe(1);
      return acceptedEmail("email-accepted-before-commit")();
    },
  ]);
  const claim = (await claimOnce(f, appointment, {
    channel: "email",
    source: "automated",
  }))!;
  await expect(
    fencedSend(f, claim, sendAppointmentReminder, appointment),
  ).resolves.toMatchObject({
    status: "called",
    result: { success: false, outcome: "outcome_unknown" },
  });
  await record(f, claim, "unknown", "automated");
  expect(await reminderRow(f, appointment)).toEqual({
    status: "pending",
    reminderAttempt: 1,
    reminderOutcome: "outcome_unknown",
  });
  const winners = await claimAll(f, appointment, MIXED);
  expect(winners).toHaveLength(1);
  expect(winners[0]).toMatchObject({ attempt: 1, redispatch: true });
  expect(seenKeys).toEqual([appointmentReminderEmailIdempotencyKey(appointment, 1)]);
  return "commit failure after acceptance: recorded unknown; the retry keeps attempt 1";
}

/**
 * A claimant that stalled past the abandoned-claim window (for example,
 * waiting on the practice recovery lock) must not send once another sender
 * reclaimed the reminder, whether that sender is mid-send or done.
 */
async function stalledEmailClaimantNeverSends(f: ReminderFixture) {
  const appointment = newAppointment(18);
  let releaseProvider!: () => void;
  const providerHeld = new Promise<void>((done) => (releaseProvider = done));
  let providerEntered!: () => void;
  const providerReached = new Promise<void>((done) => (providerEntered = done));
  const { seenKeys, sendAppointmentReminder } = await scriptedEmailProvider([
    async () => {
      providerEntered();
      await providerHeld;
      return acceptedEmail("email-from-reclaimer")();
    },
  ]);
  const stalled = (await claimOnce(f, appointment, {
    channel: "email",
    source: "staff",
  }))!;
  await f.ownerDb
    .update(schema.communications)
    .set({
      updatedAt: sql`now() - make_interval(secs => ${STALE_EMAIL_REMINDER_CLAIM_MS / 1000 + 60})`,
    })
    .where(
      eq(schema.communications.dedupeKey, appointmentReminderDedupeKey(appointment)),
    );
  const reclaimer = (await claimOnce(f, appointment, {
    channel: "email",
    source: "automated",
  }))!;
  expect(reclaimer).toMatchObject({ id: stalled.id, attempt: stalled.attempt });
  expect(reclaimer.claimToken).not.toBe(stalled.claimToken);

  // The reclaimer is mid-send, holding the row lock, when the stalled
  // claimant wakes up and tries to send.
  const reclaimerSend = fencedSend(f, reclaimer, sendAppointmentReminder, appointment);
  await providerReached;
  const stalledSend = fencedSend(f, stalled, sendAppointmentReminder, appointment);
  releaseProvider();
  await expect(reclaimerSend).resolves.toMatchObject({
    status: "called",
    result: { success: true },
  });
  await expect(stalledSend).resolves.toEqual({ status: "superseded" });
  // A late outcome from the stalled claimant can't overwrite the reclaimer.
  await record(f, stalled, "failed", "staff");
  expect(await reminderRow(f, appointment)).toMatchObject({
    status: "pending",
    reminderOutcome: null,
  });
  await record(f, reclaimer, "sent", "automated", {
    providerMessageId: "email-from-reclaimer",
  });
  await expect(
    fencedSend(f, stalled, sendAppointmentReminder, appointment),
  ).resolves.toEqual({ status: "superseded" });
  expect(seenKeys).toHaveLength(1);
  expect((await reminderRow(f, appointment))?.status).toBe("sent");
  return "stalled email claimant: blocked mid-send and after; one provider call";
}

type CachedDbGlobal = {
  __openpimsDb?: { client: { end: (o: { timeout: number }) => Promise<void> } };
};

/** Run app modules that use the shared database client against this DB. */
async function withLiveDatabase<T>(databaseUrl: string, fn: () => Promise<T>) {
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.resetModules();
  try {
    return await fn();
  } finally {
    const cache = globalThis as CachedDbGlobal;
    await cache.__openpimsDb?.client.end({ timeout: 5 });
    cache.__openpimsDb = undefined;
  }
}

async function attemptOutcomes(f: ReminderFixture, communicationId: string) {
  const events = await f.ownerDb
    .select({ outcome: schema.smsSendAttemptEvents.outcome })
    .from(schema.smsSendAttemptEvents)
    .innerJoin(
      schema.smsSendAttempts,
      eq(schema.smsSendAttempts.id, schema.smsSendAttemptEvents.attemptId),
    )
    .where(eq(schema.smsSendAttempts.communicationId, communicationId))
    .orderBy(schema.smsSendAttemptEvents.createdAt);
  return events.map((event) => event.outcome);
}

/** The same fence through the real SMS dispatcher and console provider. */
async function stalledSmsClaimantNeverSends(f: ReminderFixture, databaseUrl: string) {
  const appointment = newAppointment(19);
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
  vi.stubEnv("HOSTED_BILLING_ENABLED", "false");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return withLiveDatabase(databaseUrl, async () => {
    const { sendAppointmentReminderSms } = await import("@/lib/sms");
    const send = (claim: AppointmentReminderClaim) =>
      sendAppointmentReminderSms({
        to: "+15555550123",
        patientName: "Miso",
        appointmentDate: "Thursday, January 3, 2030",
        appointmentTime: "7:00 PM",
        practiceName: "Synthetic Reminder Clinic",
        practiceId: f.practiceId,
        clientId: f.clientId,
        communicationId: claim.id,
        source: "appointment_reminder",
        sourceId: appointmentReminderDedupeKey(appointment),
        idempotencyKey: appointmentReminderSmsIdempotencyKey(appointment, claim.attempt),
        reminderClaimToken: claim.claimToken,
      });
    const stalled = (await claimOnce(f, appointment, {
      channel: "sms",
      source: "staff",
    }))!;
    await f.ownerDb
      .update(schema.communications)
      .set({ updatedAt: sql`now() - interval '20 minutes'` })
      .where(
        eq(schema.communications.dedupeKey, appointmentReminderDedupeKey(appointment)),
      );
    // No attempt was reserved yet, so another sender recovers the claim.
    const reclaimer = (await claimOnce(f, appointment, {
      channel: "sms",
      source: "automated",
    }))!;
    expect(reclaimer).toMatchObject({ id: stalled.id, attempt: 1 });

    // The stalled claimant wakes up first and reserves the attempt, then is
    // stopped by the fence before the provider.
    await expect(send(stalled)).resolves.toMatchObject({
      success: false,
      outcome: "definite_failure",
      error: expect.stringContaining("Another send took over"),
    });
    expect(await attemptOutcomes(f, stalled.id)).toEqual(["definite_failure"]);
    // The reclaimer shares the key, so it replays that blocked attempt; its
    // recorded failure is a definite one and retries once, as attempt 2.
    await expect(send(reclaimer)).resolves.toMatchObject({
      success: false,
      replayed: true,
    });
    await record(f, reclaimer, "failed", "automated", { channel: "sms" });
    const retry = (await claimOnce(f, appointment, { channel: "sms", source: "staff" }))!;
    expect(retry.attempt).toBe(2);
    await expect(send(retry)).resolves.toMatchObject({ success: true });
    expect(await attemptOutcomes(f, stalled.id)).toEqual([
      "definite_failure",
      "accepted",
    ]);
    expect((await reminderRow(f, appointment))?.status).toBe("sent");
    return "stalled SMS claimant: stopped at the dispatcher fence; exactly one accepted send";
  });
}

/**
 * An SMS left "Delivery unknown" that an operator reconciles as a definite
 * failure must become retryable exactly once, not stay blocked forever.
 */
async function reconciledSmsFailureIsRetryableOnce(
  f: ReminderFixture,
  databaseUrl: string,
) {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  return withLiveDatabase(databaseUrl, async () => {
    const { reconcileSmsSendAttempt } = await import("@/lib/sms-dispatch");
    const results: string[] = [];
    for (const [i, source] of (["staff", "automated"] as const).entries()) {
      const appointment = newAppointment(21 + i);
      const claim = (await claimOnce(f, appointment, { channel: "sms", source }))!;
      const dedupeKey = appointmentReminderDedupeKey(appointment);
      const body = "Reminder: synthetic appointment.";
      const [attempt] = await f.ownerDb
        .insert(schema.smsSendAttempts)
        .values({
          practiceId: f.practiceId,
          clientId: f.clientId,
          communicationId: claim.id,
          source: "appointment_reminder",
          sourceId: dedupeKey,
          idempotencyKey: appointmentReminderSmsIdempotencyKey(appointment, 1),
          destinationE164: "+15555550100",
          registeredDisplayName: "Synthetic Reminder Clinic",
          body,
          bodySha256: createHash("sha256").update(body).digest("hex"),
          provider: "console",
          createdAt: sql`now() - interval '1 hour'`,
        })
        .returning({ id: schema.smsSendAttempts.id });
      await record(f, claim, "unknown", source, { channel: "sms" });
      expect(await claimAll(f, appointment, MIXED)).toHaveLength(0);

      await expect(
        reconcileSmsSendAttempt({
          practiceId: f.practiceId,
          attemptId: attempt!.id,
          outcome: "definite_failure",
          detail: "Provider confirmed the message was never sent.",
          actorUserId: "platform-operator",
          actorType: "platform_operator",
          actorIdentity: "operator@example.com",
          actorName: "Platform Operator",
          reconciliationKey: `reconcile:${attempt!.id}`,
        }),
      ).resolves.toMatchObject({ outcome: "definite_failure" });
      expect(await reminderRow(f, appointment)).toEqual({
        status: "failed",
        reminderAttempt: 1,
        reminderOutcome: source === "staff" ? "staff_failure" : "automated_failure",
      });
      // The sweep waits out its retry delay before retrying its own failure.
      await f.ownerDb
        .update(schema.communications)
        .set({ updatedAt: sql`now() - interval '2 hours'` })
        .where(eq(schema.communications.dedupeKey, dedupeKey));
      const claimers = source === "staff" ? MIXED : AUTOMATED_ONLY;
      const winners = await claimAll(f, appointment, claimers);
      expect(winners, `${source} reconciled failure`).toHaveLength(1);
      expect(winners[0]!.attempt).toBe(2);
      results.push(`${source}: 1 of ${claimers.length} reclaimed it as attempt 2`);
    }
    return `reconciled SMS failure retryable once (${results.join("; ")})`;
  });
}


afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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
              const startedMinutesAgo =
                existing.attemptStartedMinutesAgo === undefined
                  ? existing.ageMinutes
                  : existing.attemptStartedMinutesAgo;
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
                  reminderAttemptStartedAt:
                    existing.reminderAttempt === null ||
                    startedMinutesAgo === null
                      ? null
                      : sql`now() - make_interval(mins => ${startedMinutesAgo})`,
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
            const winners = await concurrentClaims(appDb, {
              practiceId,
              appointmentId,
              clientId,
              startTime,
              claimers: scenario.claimers,
            });

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
                  attemptClockFresh: sql<boolean>`${schema.communications.reminderAttemptStartedAt} > now() - interval '1 minute'`,
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
              // Only a new attempt restarts the attempt clock.
              expect(row!.attemptClockFresh, label).toBe(
                !scenario.existing ||
                  scenario.existing.reminderAttempt !== scenario.attemptAfterClaim,
              );
            } else if (scenario.rowAfterNoWinner) {
              const [row] = await ownerDb
                .select({
                  status: schema.communications.status,
                  reminderAttempt: schema.communications.reminderAttempt,
                  reminderOutcome: schema.communications.reminderOutcome,
                })
                .from(schema.communications)
                .where(eq(schema.communications.dedupeKey, dedupeKey));
              expect(row, label).toEqual(scenario.rowAfterNoWinner);
            }
            results.push(
              `${label}: ${winners.length} of ${scenario.claimers.length} claimed`,
            );
          }
        }
        results.push(
          await unknownEmailLifecycle(ownerDb, appDb, practiceId, clientId),
        );
        const fixture: ReminderFixture = { ownerDb, appDb, practiceId, clientId };
        results.push(await redispatchFailuresNeverAdvanceTheAttempt(fixture));
        results.push(await rateLimitedEmailRetriesUnderOneKey(fixture));
        results.push(await commitFailureAfterAcceptanceIsUnknown(fixture));
        results.push(await stalledEmailClaimantNeverSends(fixture));
        results.push(
          await stalledSmsClaimantNeverSends(fixture, databaseUrl.toString()),
        );
        results.push(
          await reconciledSmsFailureIsRetryableOnce(fixture, databaseUrl.toString()),
        );
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
