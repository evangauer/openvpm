import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, type Database } from "@openpims/db/client";
import {
  appointments,
  auditLog,
  clients,
  patientMergeEvents,
  patients,
  practices,
  users,
} from "@openpims/db";
import { patientsRouter } from "@/server/routers/patients";

const describeWithPostgres = process.env.PATIENT_MERGE_DB_INTEGRATION
  ? describe
  : describe.skip;

async function inRollbackFixture(
  run: (tx: Database) => Promise<void>,
): Promise<void> {
  const rollback = new Error("synthetic patient-merge fixture rollback");
  try {
    await db.transaction(async (tx) => {
      await run(tx as unknown as Database);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

function patientCaller(options: {
  tx: Database;
  practiceId: string;
  userId: string;
}) {
  return patientsRouter.createCaller({
    db: options.tx,
    session: {
      user: {
        id: options.userId,
        email: `patient-merge-${options.userId}@example.invalid`,
        name: "Synthetic merge administrator",
        role: "admin",
        practiceId: options.practiceId,
        recoveryHold: false,
      },
    },
  } as never);
}

async function seedMergeFixture(
  tx: Database,
  options: { includeActor: boolean },
) {
  const practiceId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const keepId = randomUUID();
  const mergeId = randomUUID();
  const appointmentId = randomUUID();

  await tx.insert(practices).values({
    id: practiceId,
    name: "Synthetic patient merge practice",
  });
  if (options.includeActor) {
    await tx.insert(users).values({
      id: userId,
      practiceId,
      email: `patient-merge-${userId}@example.invalid`,
      passwordHash: "integration-test-only",
      name: "Synthetic merge administrator",
      role: "admin",
    });
  }
  await tx.insert(clients).values({
    id: clientId,
    practiceId,
    firstName: "Synthetic",
    lastName: "Owner",
  });
  await tx.insert(patients).values([
    {
      id: keepId,
      practiceId,
      clientId,
      name: "Canonical patient",
      species: "canine",
    },
    {
      id: mergeId,
      practiceId,
      clientId,
      name: "Duplicate patient",
      species: "canine",
    },
  ]);
  await tx.insert(appointments).values({
    id: appointmentId,
    practiceId,
    clientId,
    patientId: mergeId,
    startTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
    endTime: new Date(Date.now() + 25 * 60 * 60 * 1000),
    status: "scheduled",
  });

  return { practiceId, userId, clientId, keepId, mergeId, appointmentId };
}

describeWithPostgres("patient merge real-Postgres safety", () => {
  it("completes through the tenant transaction without an isolation-level error", async () => {
    await inRollbackFixture(async (tx) => {
      const fixture = await seedMergeFixture(tx, { includeActor: true });
      const operationId = randomUUID();
      const caller = patientCaller({
        tx,
        practiceId: fixture.practiceId,
        userId: fixture.userId,
      });

      await expect(
        caller.merge({
          keepId: fixture.keepId,
          mergeId: fixture.mergeId,
          reason:
            "Synthetic duplicate identity reviewed for integration safety.",
          operationId,
        }),
      ).resolves.toMatchObject({
        id: fixture.keepId,
        mergeMetadata: {
          sourcePatientId: fixture.mergeId,
          canonicalId: fixture.keepId,
          replayed: false,
        },
      });

      const [source] = await tx
        .select({ deletedAt: patients.deletedAt })
        .from(patients)
        .where(eq(patients.id, fixture.mergeId));
      const [movedAppointment] = await tx
        .select({ patientId: appointments.patientId })
        .from(appointments)
        .where(eq(appointments.id, fixture.appointmentId));
      const [event] = await tx
        .select({ id: patientMergeEvents.id })
        .from(patientMergeEvents)
        .where(
          and(
            eq(patientMergeEvents.practiceId, fixture.practiceId),
            eq(patientMergeEvents.operationId, operationId),
          ),
        );
      const [audit] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.practiceId, fixture.practiceId),
            eq(auditLog.action, "merged"),
            eq(auditLog.entityId, fixture.keepId),
          ),
        );

      expect(source?.deletedAt).toBeInstanceOf(Date);
      expect(movedAppointment?.patientId).toBe(fixture.keepId);
      expect(event).toBeDefined();
      expect(audit).toBeDefined();
    });
  });

  it("rolls back earlier scheduling writes when merge evidence cannot commit", async () => {
    await inRollbackFixture(async (tx) => {
      // The actor is deliberately absent. The immutable merge-event FK fails
      // after the appointment move, proving the merge savepoint rolls every
      // preceding write back instead of leaving a partially merged chart.
      const fixture = await seedMergeFixture(tx, { includeActor: false });
      const operationId = randomUUID();
      const caller = patientCaller({
        tx,
        practiceId: fixture.practiceId,
        userId: fixture.userId,
      });

      await expect(
        caller.merge({
          keepId: fixture.keepId,
          mergeId: fixture.mergeId,
          reason: "Synthetic rollback proof for missing immutable actor.",
          operationId,
        }),
      ).rejects.toBeDefined();

      const [source] = await tx
        .select({ deletedAt: patients.deletedAt })
        .from(patients)
        .where(
          and(eq(patients.id, fixture.mergeId), isNull(patients.deletedAt)),
        );
      const [appointment] = await tx
        .select({ patientId: appointments.patientId })
        .from(appointments)
        .where(eq(appointments.id, fixture.appointmentId));
      const [event] = await tx
        .select({ id: patientMergeEvents.id })
        .from(patientMergeEvents)
        .where(
          and(
            eq(patientMergeEvents.practiceId, fixture.practiceId),
            eq(patientMergeEvents.operationId, operationId),
          ),
        );
      const [audit] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.practiceId, fixture.practiceId),
            eq(auditLog.action, "merged"),
            eq(auditLog.entityId, fixture.keepId),
          ),
        );

      expect(source).toBeDefined();
      expect(appointment?.patientId).toBe(fixture.mergeId);
      expect(event).toBeUndefined();
      expect(audit).toBeUndefined();
    });
  });
});
