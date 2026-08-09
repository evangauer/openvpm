import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { patients, users } from "@openpims/db";
import { authenticateApiKey } from "@/lib/api-auth";
import { withTenant } from "@/lib/tenant-db";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import {
  apiError,
  validationError,
  withErrorHandling,
} from "@/lib/compat/shared/errors";
import { readJsonRequestBody } from "@/lib/request-json";
import {
  type SoapNoteCreate,
  SoapNoteCreateSchema,
  toApiSoapNote,
} from "@/lib/compat/openvpm";
import {
  hasSoapContent,
  normalizeSoapSection,
} from "@/lib/records/soap-content";
import { assertActivePractice } from "@/lib/compat/shared/active-practice";
import { lockOpenVisitForClinicalAppend } from "@/lib/records/visit-integrity";
import { hasUnresolvedSoapTemplatePrompts } from "@/lib/records/soap-templates";
import {
  createFinalizedAppointmentSoapNote,
  SoapLifecycleError,
} from "@/lib/records/soap-lifecycle";

export const dynamic = "force-dynamic";

const AUTHOR_REQUIRED_MESSAGE =
  "author_id is required when the appointment has no assigned doctor.";

type TargetValidationResult =
  | { ok: true; author: { id: string; name: string } }
  | { ok: false; response: NextResponse };

async function validateSoapTargets(
  tx: Database,
  practiceId: string,
  input: SoapNoteCreate
): Promise<TargetValidationResult> {
  const [patient] = await tx
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, input.patient_id),
        eq(patients.practiceId, practiceId),
        isNull(patients.deletedAt)
      )
    )
    .limit(1);

  if (!patient) {
    return { ok: false, response: apiError("Patient not found", 404) };
  }

  const visit = await lockOpenVisitForClinicalAppend(tx, {
    practiceId,
    patientId: input.patient_id,
    appointmentId: input.appointment_id,
  });
  if (!visit.ok && visit.reason === "appointment_not_found") {
    return { ok: false, response: apiError("Appointment not found", 404) };
  }
  if (!visit.ok) {
    return {
      ok: false,
      response: apiError(
        "SOAP notes can only be added while the visit is in exam.",
        409
      ),
    };
  }

  const authorId = input.author_id ?? visit.appointment.doctorId;
  if (!authorId) {
    return { ok: false, response: apiError(AUTHOR_REQUIRED_MESSAGE, 400) };
  }

  const [author] = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.id, authorId),
        eq(users.practiceId, practiceId),
        inArray(users.role, ["admin", "veterinarian"]),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (!author) {
    return { ok: false, response: apiError("Author not found", 404) };
  }

  return { ok: true, author };
}

// POST /api/v1/soap-notes - create a SOAP note for an external AI scribe.
export async function POST(req: Request) {
  const auth = await authenticateApiKey(req, "records:write");
  if (!auth.ok) return auth.response;

  return withErrorHandling(async () => {
    const body = await readJsonRequestBody(req);
    if (!body.ok) {
      if (body.reason === "too_large") {
        return apiError("Request body too large", 413);
      }
      return apiError("Request body must be valid JSON", 400);
    }

    const parsed = SoapNoteCreateSchema.safeParse(body.data);
    if (!parsed.success) return validationError(parsed.error);

    const normalizedNote = {
      subjective: normalizeSoapSection(parsed.data.subjective),
      objective: normalizeSoapSection(parsed.data.objective),
      assessment: normalizeSoapSection(parsed.data.assessment),
      plan: normalizeSoapSection(parsed.data.plan),
    };
    if (!hasSoapContent(normalizedNote)) {
      return apiError("SOAP note must include at least one section.", 400);
    }
    if (hasUnresolvedSoapTemplatePrompts(normalizedNote)) {
      return apiError(
        "Replace or delete every SOAP template prompt before saving.",
        400
      );
    }
    let result;
    try {
      result = await withTenant(db, auth.ctx.practiceId, async (tx) => {
        const activePractice = await assertActivePractice(
          tx,
          auth.ctx.practiceId,
        );
        if (!activePractice.ok) {
          return { ok: false as const, response: activePractice.response };
        }

        const targets = await validateSoapTargets(
          tx,
          auth.ctx.practiceId,
          parsed.data,
        );
        if (!targets.ok) {
          return { ok: false as const, response: targets.response };
        }

        try {
          const row = await createFinalizedAppointmentSoapNote(tx, {
            patientId: parsed.data.patient_id,
            appointmentId: parsed.data.appointment_id,
            actor: targets.author,
            sections: normalizedNote,
            practiceId: auth.ctx.practiceId,
          });
          await tx.execute(sql`set constraints all immediate`);
          return { ok: true as const, row };
        } catch (error) {
          if (error instanceof SoapLifecycleError) {
            const status =
              error.code === "NOT_FOUND"
                ? 404
                : error.code === "BAD_REQUEST"
                  ? 400
                  : 409;
            return {
              ok: false as const,
              response: apiError(error.message, status),
            };
          }
          // Database errors must leave the tenant callback so withTenant can
          // roll the transaction back before this route translates them.
          throw error;
        }
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23514" &&
        "constraint_name" in error &&
        error.constraint_name === "soap_notes_appointment_invariant"
      ) {
        return apiError(
          "Clinical documentation changed in another session. Refresh and retry.",
          409,
        );
      }
      throw error;
    }
    if (!result.ok) return result.response;

    const apiSoapNote = toApiSoapNote(result.row, parsed.data.source);
    await dispatchWebhookEvent(auth.ctx.practiceId, "soap_note.created", {
      id: result.row.id,
      patientId: result.row.patientId,
      appointmentId: result.row.appointmentId,
      authorId: result.row.authorId,
      source: parsed.data.source,
    });

    return NextResponse.json({ data: apiSoapNote }, { status: 201 });
  });
}
