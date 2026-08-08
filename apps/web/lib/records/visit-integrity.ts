import { and, eq, isNull, sql } from "drizzle-orm";
import { appointments, practices, visitCloseouts } from "@openpims/db";
import type { Database } from "@openpims/db/client";

export type ClinicalAppendFailure =
  | "appointment_not_found"
  | "visit_not_open"
  | "visit_finalized";

export type ClinicalAppendGuard =
  | {
      ok: true;
      appointment: {
        id: string;
        doctorId: string | null;
        status: "in_exam";
      };
    }
  | { ok: false; reason: ClinicalAppendFailure };

/**
 * Lock and validate a visit before appending appointment-linked clinical data.
 * The caller must keep this transaction open through the subsequent write so
 * closeout/finalization cannot race the append after validation.
 */
export async function lockOpenVisitForClinicalAppend(
  db: Database,
  input: { practiceId: string; patientId: string; appointmentId: string },
): Promise<ClinicalAppendGuard> {
  const [appointment] = await db
    .select({
      id: appointments.id,
      doctorId: appointments.doctorId,
      status: appointments.status,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, input.appointmentId),
        eq(appointments.patientId, input.patientId),
        eq(appointments.practiceId, input.practiceId),
        isNull(appointments.deletedAt),
        sql`exists (
          select 1
          from ${practices}
          where ${practices.id} = ${input.practiceId}
            and ${practices.deletedAt} is null
        )`,
      ),
    )
    .for("update");

  if (!appointment) {
    return { ok: false, reason: "appointment_not_found" };
  }
  if (appointment.status !== "in_exam") {
    return { ok: false, reason: "visit_not_open" };
  }

  const [closeout] = await db
    .select({ status: visitCloseouts.status })
    .from(visitCloseouts)
    .where(
      and(
        eq(visitCloseouts.appointmentId, appointment.id),
        eq(visitCloseouts.practiceId, input.practiceId),
        isNull(visitCloseouts.deletedAt),
      ),
    )
    .limit(1);

  if (
    closeout?.status === "clinical_finalized" ||
    closeout?.status === "completed"
  ) {
    return { ok: false, reason: "visit_finalized" };
  }

  return {
    ok: true,
    appointment: {
      id: appointment.id,
      doctorId: appointment.doctorId,
      status: "in_exam",
    },
  };
}
