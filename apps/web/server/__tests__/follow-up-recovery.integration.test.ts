import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as schema from "../../../../packages/db/schema/index";
import { appRouter } from "../routers/_app";

// Opt-in PostgreSQL contract for follow-up recovery after a cancelled or
// missed follow-up appointment. It runs only against an already created,
// already migrated synthetic database supplied by
// FOLLOWUP_TEST_DATABASE_URL. It never creates or drops databases, runs
// migrations, applies row-level security, or changes roles.
//
// The connection is the database owner, so PostgreSQL row-level security is
// NOT exercised here. Tenant isolation below is the application-layer
// practice scoping only; full RLS enforcement remains unverified.

// The generic post-commit audit runs on a separate system connection; the
// follow-up audit under test is written inside the router transaction.
vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tenant-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant-db")>()),
  withSystem: vi.fn(async () => undefined),
}));
// No external webhook delivery from synthetic status changes.
vi.mock("@/lib/appointment-webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/appointment-webhooks")>()),
  dispatchAppointmentWebhookAfterCommit: vi.fn(async () => undefined),
}));

const databaseUrl = process.env.FOLLOWUP_TEST_DATABASE_URL;
const describeWithFollowUpPostgres = databaseUrl ? describe : describe.skip;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DATABASE_NAME_PATTERN = /^openvpm_followup_test_[A-Za-z0-9_]+$/;

function expectedDatabaseName(raw: string): string {
  const url = new URL(raw);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Follow-up recovery tests require a loopback database host");
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(
      "Follow-up recovery tests require an openvpm_followup_test_ database",
    );
  }
  return name;
}

type AppDatabase = ReturnType<typeof drizzle<typeof schema>>;
type Role = "admin" | "veterinarian" | "technician" | "front_desk";

function callerFor(
  database: AppDatabase,
  practiceId: string,
  userId: string,
  role: Role = "front_desk",
) {
  return appRouter.createCaller({
    db: database,
    session: {
      user: {
        id: userId,
        email: `${role}@synthetic.invalid`,
        name: "Synthetic Front Desk",
        role,
        practiceId,
      },
    },
  } as never);
}

const DAY = 86_400_000;
const at = (offsetDays: number, hour = 15) => {
  const value = new Date(Date.now() + offsetDays * DAY);
  value.setUTCHours(hour, 0, 0, 0);
  return value;
};

describeWithFollowUpPostgres("follow-up recovery PostgreSQL contract", () => {
  let pg: ReturnType<typeof postgres>;
  let db: AppDatabase;
  const run = randomUUID().replaceAll("-", "").slice(0, 12);
  const ids = {} as Record<
    | "practice"
    | "otherPractice"
    | "location"
    | "otherLocation"
    | "staff"
    | "otherStaff"
    | "client"
    | "patient"
    | "otherClient"
    | "otherPatient"
    | "visit"
    | "original"
    | "replacementA"
    | "replacementB"
    | "neededVisit"
    | "neededBooking"
    | "terminalVisit"
    | "terminalBooking"
    | "noneVisit"
    | "otherVisit"
    | "otherBooking"
    | "otherFuture"
    | "closeout"
    | "neededCloseout"
    | "terminalCloseout"
    | "noneCloseout"
    | "otherCloseout",
    string
  >;
  const times = {
    visit: at(-2, 15),
    original: at(7, 15),
    replacementA: at(10, 15),
    replacementB: at(14, 15),
    neededBooking: at(8, 17),
    terminalBooking: at(9, 17),
  };

  const caller = () => callerFor(db, ids.practice, ids.staff);
  const otherCaller = () => callerFor(db, ids.otherPractice, ids.otherStaff);

  async function queueEntry(closeoutId: string) {
    const queue = await caller().encounters.listPendingFollowUps();
    return queue.find((item) => item.closeoutId === closeoutId) ?? null;
  }

  async function closeoutRow(closeoutId: string) {
    const [row] = await db
      .select()
      .from(schema.visitCloseouts)
      .where(eq(schema.visitCloseouts.id, closeoutId));
    return row!;
  }

  function signedFields(row: typeof schema.visitCloseouts.$inferSelect) {
    return {
      status: row.status,
      dischargeInstructions: row.dischargeInstructions,
      prescriptionDisposition: row.prescriptionDisposition,
      followUpDisposition: row.followUpDisposition,
      followUpNotes: row.followUpNotes,
      followUpAppointmentId: row.followUpAppointmentId,
      followUpScheduledAt: row.followUpScheduledAt,
      followUpDueDate: row.followUpDueDate,
      followUpAssignedTo: row.followUpAssignedTo,
      followUpAssigneeName: row.followUpAssigneeName,
      clinicalFinalizedAt: row.clinicalFinalizedAt,
      clinicalFinalizedBy: row.clinicalFinalizedBy,
      clinicalFinalizerName: row.clinicalFinalizerName,
      amendmentHistory: row.amendmentHistory,
      completedAt: row.completedAt,
    };
  }

  beforeAll(async () => {
    const name = expectedDatabaseName(databaseUrl!);
    pg = postgres(databaseUrl!, { max: 4 });
    // Verify the live connection before any fixture mutation.
    const [current] = await pg<{ name: string }[]>`
      select current_database() as name
    `;
    expect(current?.name).toBe(name);
    const [constraint] = await pg<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'visit_closeouts_follow_up_resolution_check'
    `;
    expect(
      constraint?.definition,
      "Apply the follow-up recovery migration to this synthetic database first",
    ).toMatch(/follow_up_disposition\s*=\s*ANY/);
    db = drizzle(pg, { schema });

    const [practice, otherPractice] = await db
      .insert(schema.practices)
      .values([
        { name: `Synthetic Follow-up Clinic ${run}` },
        { name: `Other Synthetic Clinic ${run}` },
      ])
      .returning({ id: schema.practices.id });
    ids.practice = practice!.id;
    ids.otherPractice = otherPractice!.id;
    const [location, otherLocation] = await db
      .insert(schema.locations)
      .values([
        { practiceId: ids.practice, name: "Main", isPrimary: true },
        { practiceId: ids.otherPractice, name: "Other", isPrimary: true },
      ])
      .returning({ id: schema.locations.id });
    ids.location = location!.id;
    ids.otherLocation = otherLocation!.id;
    const [staff, otherStaff] = await db
      .insert(schema.users)
      .values([
        {
          practiceId: ids.practice,
          email: `followup-desk-${run}@example.invalid`,
          passwordHash: "not-a-real-password-hash",
          name: "Synthetic Front Desk",
          role: "front_desk",
          emailVerifiedAt: new Date(),
        },
        {
          practiceId: ids.otherPractice,
          email: `followup-other-${run}@example.invalid`,
          passwordHash: "not-a-real-password-hash",
          name: "Other Synthetic Desk",
          role: "front_desk",
          emailVerifiedAt: new Date(),
        },
      ])
      .returning({ id: schema.users.id });
    ids.staff = staff!.id;
    ids.otherStaff = otherStaff!.id;
    const [client, otherClient] = await db
      .insert(schema.clients)
      .values([
        { practiceId: ids.practice, firstName: "Synthetic", lastName: `Owner ${run}` },
        { practiceId: ids.otherPractice, firstName: "Other", lastName: `Owner ${run}` },
      ])
      .returning({ id: schema.clients.id });
    ids.client = client!.id;
    ids.otherClient = otherClient!.id;
    const [patient, otherPatient] = await db
      .insert(schema.patients)
      .values([
        {
          practiceId: ids.practice,
          clientId: ids.client,
          name: `Synthetic Recovery ${run}`,
          species: "canine",
        },
        {
          practiceId: ids.otherPractice,
          clientId: ids.otherClient,
          name: `Other Recovery ${run}`,
          species: "feline",
        },
      ])
      .returning({ id: schema.patients.id });
    ids.patient = patient!.id;
    ids.otherPatient = otherPatient!.id;

    const booking = (
      start: Date,
      status: "scheduled" | "checked_out" | "cancelled" = "scheduled",
      other = false,
    ) => ({
      practiceId: other ? ids.otherPractice : ids.practice,
      locationId: other ? ids.otherLocation : ids.location,
      clientId: other ? ids.otherClient : ids.client,
      patientId: other ? ids.otherPatient : ids.patient,
      startTime: start,
      endTime: new Date(start.getTime() + 30 * 60_000),
      status,
      notes: "Synthetic follow-up recovery fixture",
    });
    const rows = await db
      .insert(schema.appointments)
      .values([
        booking(times.visit, "checked_out"),
        booking(times.original),
        booking(times.replacementA),
        booking(times.replacementB),
        booking(at(-3, 15), "checked_out"),
        booking(times.neededBooking),
        booking(at(-4, 15), "checked_out"),
        booking(times.terminalBooking, "cancelled"),
        booking(at(-5, 15), "checked_out"),
        booking(at(-2, 15), "checked_out", true),
        booking(at(7, 15), "cancelled", true),
        booking(at(12, 15), "scheduled", true),
      ])
      .returning({ id: schema.appointments.id });
    (
      [
        "visit",
        "original",
        "replacementA",
        "replacementB",
        "neededVisit",
        "neededBooking",
        "terminalVisit",
        "terminalBooking",
        "noneVisit",
        "otherVisit",
        "otherBooking",
        "otherFuture",
      ] as const
    ).forEach((key, index) => {
      ids[key] = rows[index]!.id;
    });

    const signed = (practiceId: string, appointmentId: string, finalizer: string) => ({
      practiceId,
      appointmentId,
      status: "completed" as const,
      dischargeInstructions: "Synthetic discharge instructions.",
      prescriptionDisposition: "not_needed" as const,
      documentationExceptionReason: "Synthetic fixture",
      clinicalFinalizedAt: new Date(Date.now() - DAY),
      clinicalFinalizedBy: finalizer,
      clinicalFinalizerName: "Synthetic Clinician",
      chargeDisposition: "no_charge" as const,
      noChargeReason: "Synthetic fixture",
      handoffMethod: "verbal" as const,
      completedAt: new Date(Date.now() - DAY),
      completedBy: finalizer,
      revision: 2,
    });
    const closeouts = await db
      .insert(schema.visitCloseouts)
      .values([
        {
          ...signed(ids.practice, ids.visit, ids.staff),
          followUpDisposition: "scheduled",
          followUpAppointmentId: ids.original,
          followUpScheduledAt: times.original,
        },
        {
          ...signed(ids.practice, ids.neededVisit, ids.staff),
          followUpDisposition: "needed",
          followUpDueDate: "2099-01-01",
          followUpAssignedTo: ids.staff,
          followUpAssigneeName: "Synthetic Front Desk",
          followUpResolution: "scheduled",
          followUpResolutionAppointmentId: ids.neededBooking,
          followUpResolutionScheduledAt: times.neededBooking,
          followUpResolvedAt: new Date(Date.now() - DAY),
          followUpResolvedBy: ids.staff,
          followUpResolverName: "Synthetic Front Desk",
        },
        {
          ...signed(ids.practice, ids.terminalVisit, ids.staff),
          followUpDisposition: "scheduled",
          followUpAppointmentId: ids.terminalBooking,
          followUpScheduledAt: times.terminalBooking,
          followUpResolution: "completed",
          followUpResolutionNotes: "Seen elsewhere",
          followUpResolvedAt: new Date(Date.now() - DAY),
          followUpResolvedBy: ids.staff,
          followUpResolverName: "Synthetic Front Desk",
        },
        {
          ...signed(ids.practice, ids.noneVisit, ids.staff),
          followUpDisposition: "none",
        },
        {
          ...signed(ids.otherPractice, ids.otherVisit, ids.otherStaff),
          followUpDisposition: "scheduled",
          followUpAppointmentId: ids.otherBooking,
          followUpScheduledAt: at(7, 15),
        },
      ])
      .returning({ id: schema.visitCloseouts.id });
    (
      [
        "closeout",
        "neededCloseout",
        "terminalCloseout",
        "noneCloseout",
        "otherCloseout",
      ] as const
    ).forEach((key, index) => {
      ids[key] = closeouts[index]!.id;
    });
  }, 60_000);

  afterAll(async () => {
    await pg?.end({ timeout: 2 });
  });

  it("keeps booked and terminal follow-ups out of the queue and isolates other clinics", async () => {
    expect(await queueEntry(ids.closeout)).toBeNull();
    expect(await queueEntry(ids.neededCloseout)).toBeNull();
    // A completed outcome stays closed even though its booking was cancelled.
    expect(await queueEntry(ids.terminalCloseout)).toBeNull();
    expect(await queueEntry(ids.noneCloseout)).toBeNull();
    // The other clinic's cancelled follow-up is visible only to that clinic.
    expect(await queueEntry(ids.otherCloseout)).toBeNull();
    const otherQueue = await otherCaller().encounters.listPendingFollowUps();
    expect(otherQueue.map((item) => item.closeoutId)).toEqual([
      ids.otherCloseout,
    ]);
  });

  it("returns a cancelled signed booking to the clinic-team queue without changing the signed handoff", async () => {
    const before = await closeoutRow(ids.closeout);
    await caller().appointments.updateStatus({
      id: ids.original,
      status: "cancelled",
    });

    expect(await queueEntry(ids.closeout)).toMatchObject({
      appointmentId: ids.visit,
      followUpDisposition: "scheduled",
      recoveryReason: "cancelled",
      missedAppointmentId: ids.original,
      missedAppointmentAt: times.original,
      dueDate: null,
      assignedTo: null,
      assigneeName: null,
    });
    const visit = await caller().encounters.getCloseout({
      appointmentId: ids.visit,
    });
    expect(visit.followUpRecovery).toEqual({
      reason: "cancelled",
      appointmentId: ids.original,
      appointmentAt: times.original,
    });
    expect(signedFields(await closeoutRow(ids.closeout))).toEqual(
      signedFields(before),
    );
  });

  it("rejects cross-clinic access and replacements", async () => {
    const { revision } = await closeoutRow(ids.closeout);
    await expect(
      otherCaller().encounters.resolveNeededFollowUp({
        appointmentId: ids.visit,
        expectedRevision: revision,
        resolution: "scheduled",
        resolutionAppointmentId: ids.otherFuture,
        notes: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      otherCaller().appointments.updateStatus({
        id: ids.original,
        status: "scheduled",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller().encounters.resolveNeededFollowUp({
        appointmentId: ids.visit,
        expectedRevision: revision,
        resolution: "scheduled",
        resolutionAppointmentId: ids.otherFuture,
        notes: null,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const after = await closeoutRow(ids.closeout);
    expect(after.revision).toBe(revision);
    expect(after.followUpResolvedAt).toBeNull();
  });

  it("rolls back the relink when its audit record cannot be written", async () => {
    const before = await closeoutRow(ids.closeout);
    const fault = `followup_recovery_audit_fault_${run}`;
    await pg.unsafe(`
      create function public.${fault}()
      returns trigger language plpgsql set search_path = '' as $$
      begin
        if new.entity_id = '${ids.closeout}'::uuid then
          raise exception 'synthetic follow-up audit fault';
        end if;
        return new;
      end $$;
      create trigger ${fault}
        before insert on public.audit_log
        for each row execute function public.${fault}();
    `);
    try {
      await expect(
        caller().encounters.resolveNeededFollowUp({
          appointmentId: ids.visit,
          expectedRevision: before.revision,
          resolution: "scheduled",
          resolutionAppointmentId: ids.replacementA,
          notes: null,
        }),
      ).rejects.toThrow();
    } finally {
      await pg.unsafe(`
        drop trigger if exists ${fault} on public.audit_log;
        drop function if exists public.${fault}();
      `);
    }
    const after = await closeoutRow(ids.closeout);
    expect(after.revision).toBe(before.revision);
    expect(after.followUpResolution).toBeNull();
    expect(after.followUpResolutionAppointmentId).toBeNull();
    expect(await queueEntry(ids.closeout)).not.toBeNull();
  });

  it("lets exactly one concurrent relink win and audits it with before/after state", async () => {
    const before = await closeoutRow(ids.closeout);
    const attempts = await Promise.allSettled(
      [ids.replacementA, ids.replacementB].map((replacementId) =>
        caller().encounters.resolveNeededFollowUp({
          appointmentId: ids.visit,
          expectedRevision: before.revision,
          resolution: "scheduled",
          resolutionAppointmentId: replacementId,
          notes: null,
        }),
      ),
    );
    const winners = attempts.filter((result) => result.status === "fulfilled");
    const losers = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toMatchObject({ code: "CONFLICT" });

    const after = await closeoutRow(ids.closeout);
    const winner = after.followUpResolutionAppointmentId!;
    expect([ids.replacementA, ids.replacementB]).toContain(winner);
    expect(after).toMatchObject({
      revision: before.revision + 1,
      followUpResolution: "scheduled",
      followUpResolvedBy: ids.staff,
    });
    expect(signedFields(after)).toEqual(signedFields(before));
    expect(await queueEntry(ids.closeout)).toBeNull();

    const audits = await db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.entityType, "visit_closeout"),
          eq(schema.auditLog.entityId, ids.closeout),
        ),
      )
      .orderBy(asc(schema.auditLog.createdAt));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      practiceId: ids.practice,
      userId: ids.staff,
      action: "follow_up_recovered",
      changes: {
        appointmentId: ids.visit,
        recovery: {
          reason: "cancelled",
          missedAppointmentId: ids.original,
          missedAppointmentAt: times.original.toISOString(),
        },
        before: {
          followUpResolution: null,
          followUpResolutionAppointmentId: null,
          revision: before.revision,
        },
        after: {
          followUpResolution: "scheduled",
          followUpResolutionAppointmentId: winner,
          revision: before.revision + 1,
        },
      },
    });
  });

  it("returns when the replacement is cancelled, and the latest link wins over a restored original", async () => {
    const linked = await closeoutRow(ids.closeout);
    const winner = linked.followUpResolutionAppointmentId!;
    const remaining =
      winner === ids.replacementA ? ids.replacementB : ids.replacementA;
    const winnerStart =
      winner === ids.replacementA ? times.replacementA : times.replacementB;

    await caller().appointments.updateStatus({ id: winner, status: "cancelled" });
    expect(await queueEntry(ids.closeout)).toMatchObject({
      recoveryReason: "cancelled",
      missedAppointmentId: winner,
      missedAppointmentAt: winnerStart,
    });

    // Restoring the clinician's original booking does not override the newer
    // replacement link; the cancelled replacement still needs attention.
    await caller().appointments.updateStatus({
      id: ids.original,
      status: "scheduled",
    });
    expect(await queueEntry(ids.closeout)).toMatchObject({
      missedAppointmentId: winner,
    });

    const current = await closeoutRow(ids.closeout);
    await caller().encounters.resolveNeededFollowUp({
      appointmentId: ids.visit,
      expectedRevision: current.revision,
      resolution: "scheduled",
      resolutionAppointmentId: remaining,
      notes: null,
    });
    expect(await queueEntry(ids.closeout)).toBeNull();
    const final = await closeoutRow(ids.closeout);
    expect(final.followUpResolutionAppointmentId).toBe(remaining);
    expect(final.followUpAppointmentId).toBe(ids.original);
  });

  it("clears recovery when the effective booking is restored and rejects a stale recovery decision", async () => {
    const before = await closeoutRow(ids.closeout);
    const effective = before.followUpResolutionAppointmentId!;
    await caller().appointments.updateStatus({ id: effective, status: "cancelled" });
    expect(await queueEntry(ids.closeout)).toMatchObject({ missedAppointmentId: effective });

    await caller().appointments.updateStatus({ id: effective, status: "scheduled" });
    expect(await queueEntry(ids.closeout)).toBeNull();
    expect((await caller().encounters.getCloseout({ appointmentId: ids.visit })).followUpRecovery).toBeNull();
    await expect(caller().encounters.resolveNeededFollowUp({
      appointmentId: ids.visit,
      expectedRevision: before.revision,
      resolution: "completed",
      notes: "Stale recovery decision must not close a restored booking",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await closeoutRow(ids.closeout)).toEqual(before);
  });

  it("recovers a soft-deleted effective booking and rebooks without changing signed fields", async () => {
    const before = await closeoutRow(ids.closeout);
    const effective = before.followUpResolutionAppointmentId!;
    // Use the real schedule deletion path: it marks the row cancelled and
    // soft-deleted. Recovery must retain that link even though the schedule
    // hides it. No physical deletion is supported by this workflow.
    await caller().appointments.delete({ id: effective, reason: "Synthetic schedule correction" });
    expect(await queueEntry(ids.closeout)).toMatchObject({
      recoveryReason: "cancelled",
      missedAppointmentId: effective,
    });
    expect((await caller().encounters.getCloseout({ appointmentId: ids.visit })).followUpRecovery)
      .toMatchObject({ reason: "cancelled", appointmentId: effective });
    await caller().encounters.resolveNeededFollowUp({
      appointmentId: ids.visit,
      expectedRevision: before.revision,
      resolution: "scheduled",
      resolutionAppointmentId: ids.original,
      notes: null,
    });
    const after = await closeoutRow(ids.closeout);
    expect(signedFields(after)).toEqual(signedFields(before));
    expect(after.followUpResolutionAppointmentId).toBe(ids.original);
    expect(await queueEntry(ids.closeout)).toBeNull();
  });

  it("keeps the named owner on a missed needed follow-up and keeps a terminal outcome closed", async () => {
    await caller().appointments.updateStatus({
      id: ids.neededBooking,
      status: "no_show",
    });
    expect(await queueEntry(ids.neededCloseout)).toMatchObject({
      followUpDisposition: "needed",
      recoveryReason: "no_show",
      missedAppointmentId: ids.neededBooking,
      missedAppointmentAt: times.neededBooking,
      dueDate: "2099-01-01",
      assignedTo: ids.staff,
      assigneeName: "Synthetic Front Desk",
    });

    const before = await closeoutRow(ids.neededCloseout);
    await caller().encounters.resolveNeededFollowUp({
      appointmentId: ids.neededVisit,
      expectedRevision: before.revision,
      resolution: "completed",
      notes: "Synthetic owner phone check-in",
    });
    expect(await queueEntry(ids.neededCloseout)).toBeNull();
    const after = await closeoutRow(ids.neededCloseout);
    expect(after.followUpAssignedTo).toBe(ids.staff);
    expect(after.followUpDueDate).toBe("2099-01-01");

    // Later booking changes do not reopen a terminal outcome.
    await caller().appointments.updateStatus({
      id: ids.neededBooking,
      status: "scheduled",
    });
    await caller().appointments.updateStatus({
      id: ids.neededBooking,
      status: "cancelled",
    });
    expect(await queueEntry(ids.neededCloseout)).toBeNull();
    await expect(
      caller().encounters.resolveNeededFollowUp({
        appointmentId: ids.terminalVisit,
        expectedRevision: (await closeoutRow(ids.terminalCloseout)).revision,
        resolution: "scheduled",
        resolutionAppointmentId: ids.replacementA,
        notes: null,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("still rejects operational resolution on a visit with no follow-up", async () => {
    const error = await db
      .update(schema.visitCloseouts)
      .set({
        followUpResolution: "completed",
        followUpResolutionNotes: "Not allowed",
        followUpResolvedAt: new Date(),
        followUpResolvedBy: ids.staff,
        followUpResolverName: "Synthetic Front Desk",
      })
      .where(eq(schema.visitCloseouts.id, ids.noneCloseout))
      .then(
        () => null,
        (caught: unknown) => caught as { cause?: unknown },
      );
    expect(error, "the narrowed CHECK must still reject this").not.toBeNull();
    expect(error?.cause ?? error).toMatchObject({
      code: "23514",
      constraint_name: "visit_closeouts_follow_up_resolution_check",
    });
    expect((await closeoutRow(ids.noneCloseout)).followUpResolvedAt).toBeNull();
  });
});
