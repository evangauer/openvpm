import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  practices,
  prescriptionEvents,
  prescriptions,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";

export const PRESCRIPTION_EXPIRY_BATCH_SIZE = 250;

export async function expireDuePrescriptions(database: Database = db) {
  return withSystem(database, async (tx) => {
    const due = await tx
      .select({
        id: prescriptions.id,
        practiceId: prescriptions.practiceId,
        patientId: prescriptions.patientId,
        productId: prescriptions.productId,
        quantity: prescriptions.quantity,
        refillsRemaining: prescriptions.refillsRemaining,
      })
      .from(prescriptions)
      .innerJoin(
        practices,
        and(
          eq(prescriptions.practiceId, practices.id),
          eq(practices.recoveryHold, false),
          isNull(practices.deletedAt),
        ),
      )
      .where(
        and(
          eq(prescriptions.status, "active"),
          isNotNull(prescriptions.endDate),
          sql`${prescriptions.endDate} < (
            now() at time zone coalesce(nullif(btrim(${practices.timezone}), ''), 'UTC')
          )::date`,
          isNull(prescriptions.deletedAt),
        ),
      )
      .limit(PRESCRIPTION_EXPIRY_BATCH_SIZE)
      .for("update", { of: prescriptions, skipLocked: true });

    const expired: Array<{ id: string; practiceId: string; patientId: string }> = [];
    for (const prescription of due) {
      const [updated] = await tx
        .update(prescriptions)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            eq(prescriptions.id, prescription.id),
            eq(prescriptions.practiceId, prescription.practiceId),
            eq(prescriptions.status, "active"),
            isNull(prescriptions.deletedAt),
          ),
        )
        .returning({
          id: prescriptions.id,
          practiceId: prescriptions.practiceId,
          patientId: prescriptions.patientId,
        });
      if (!updated) continue;

      await tx.insert(prescriptionEvents).values({
        practiceId: prescription.practiceId,
        prescriptionId: prescription.id,
        patientId: prescription.patientId,
        productId: prescription.productId,
        quantity: prescription.quantity,
        eventType: "expired",
        statusBefore: "active",
        statusAfter: "expired",
        refillsBefore: prescription.refillsRemaining,
        refillsAfter: prescription.refillsRemaining,
        reason: "Prescription end date elapsed.",
        actorId: null,
        actorName: "OpenVPM system",
        operationId: null,
      });
      expired.push(updated);
    }

    return { expired: expired.length, prescriptions: expired };
  });
}
