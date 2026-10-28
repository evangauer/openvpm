import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  appointments,
  auditLog,
  clinicalNotes,
  clinicalRecordCorrections,
  patients,
  patientAllergies,
  practices,
  soapNotes,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  chartSnapshotSchema,
  EMPTY_SOAP,
  OFFLINE_ACCESS_MS,
  soapRequestSchema,
} from "@/lib/offline/workspace";
import {
  getAppointmentSoapDraft,
  saveAppointmentSoapDraft,
  SoapLifecycleError,
} from "@/lib/records/soap-lifecycle";

// Recheck current membership and role. A cached session must not revive access
// after an account, practice, or clinical permission changes.
const offlineProcedure = protectedProcedure
  .use(requireRole("admin", "veterinarian"))
  .use(async ({ ctx, next }) => {
    const [actor] = await ctx.db
      .select({
        role: users.role,
        userName: users.name,
        practiceName: practices.name,
        recoveryHold: practices.recoveryHold,
      })
      .from(users)
      .innerJoin(
        practices,
        and(eq(practices.id, users.practiceId), isNull(practices.deletedAt)),
      )
      .where(
        and(
          eq(users.id, ctx.user.id),
          eq(users.practiceId, ctx.practiceId),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (
      !actor ||
      !["admin", "veterinarian"].includes(actor.role) ||
      actor.recoveryHold
    )
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Offline clinical access is unavailable for this account.",
      });
    const now = Date.now();
    return next({
      ctx: {
        ...ctx,
        offlineIdentity: {
          userId: ctx.user.id,
          practiceId: ctx.practiceId,
          userName: actor.userName,
          practiceName: actor.practiceName,
          authorizedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + OFFLINE_ACCESS_MS).toISOString(),
          enabled: process.env.NEXT_PUBLIC_OFFLINE_WORKSPACE_ENABLED === "true",
        },
      },
    });
  });

function sections(note: {
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
}) {
  return {
    subjective: note.subjective ?? "",
    objective: note.objective ?? "",
    assessment: note.assessment ?? "",
    plan: note.plan ?? "",
  };
}

export const offlineRouter = createRouter({
  session: offlineProcedure.query(({ ctx }) => ctx.offlineIdentity),
  prepareChart: offlineProcedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        appointmentId: z.string().uuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.offlineIdentity.enabled)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Offline chart preparation is not enabled for this deployment.",
        });
      const [patient] = await ctx.db
        .select({
          id: patients.id,
          name: patients.name,
          species: patients.species,
          breed: patients.breed,
          sex: patients.sex,
          dob: patients.dob,
        })
        .from(patients)
        .where(
          and(
            eq(patients.id, input.patientId),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt),
          ),
        )
        .for("share");
      if (!patient)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Patient not found.",
        });
      const allergies = await ctx.db
        .select({
          allergen: patientAllergies.allergen,
          reaction: patientAllergies.reaction,
          severity: patientAllergies.severity,
        })
        .from(patientAllergies)
        .where(
          and(
            eq(patientAllergies.patientId, patient.id),
            isNull(patientAllergies.deletedAt),
          ),
        )
        .orderBy(desc(patientAllergies.notedAt))
        .limit(51);
      // Fail rather than silently omit a safety-critical allergy.
      if (allergies.length > 50)
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "This chart needs online review because its allergy list exceeds the offline limit.",
        });
      const notes = await ctx.db
        .select({
          content: clinicalNotes.content,
          type: clinicalNotes.noteType,
          at: clinicalNotes.createdAt,
        })
        .from(clinicalNotes)
        .where(
          and(
            eq(clinicalNotes.practiceId, ctx.practiceId),
            eq(clinicalNotes.patientId, patient.id),
            eq(clinicalNotes.isChartNote, true),
            isNull(clinicalNotes.deletedAt),
          ),
        )
        .orderBy(desc(clinicalNotes.createdAt), desc(clinicalNotes.id))
        .limit(20);
      const history = await ctx.db
        .select()
        .from(soapNotes)
        .where(
          and(
            eq(soapNotes.practiceId, ctx.practiceId),
            eq(soapNotes.patientId, patient.id),
            eq(soapNotes.status, "finalized"),
            isNull(soapNotes.deletedAt),
            sql`not exists (select 1 from ${clinicalRecordCorrections} where ${clinicalRecordCorrections.practiceId} = ${ctx.practiceId} and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id})`,
          ),
        )
        .orderBy(desc(soapNotes.finalizedAt), desc(soapNotes.id))
        .limit(5);
      let visit = null;
      if (input.appointmentId) {
        const [appointment] = await ctx.db
          .select()
          .from(appointments)
          .where(
            and(
              eq(appointments.id, input.appointmentId),
              eq(appointments.practiceId, ctx.practiceId),
              eq(appointments.patientId, patient.id),
              isNull(appointments.deletedAt),
            ),
          )
          .for("share");
        if (!appointment)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Visit not found.",
          });
        if (appointment.status !== "in_exam")
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Start the visit online before preparing its offline note.",
          });
        const [finalized] = await ctx.db
          .select({ id: soapNotes.id })
          .from(soapNotes)
          .where(
            and(
              eq(soapNotes.practiceId, ctx.practiceId),
              eq(soapNotes.appointmentId, appointment.id),
              eq(soapNotes.status, "finalized"),
              isNull(soapNotes.deletedAt),
              sql`not exists (select 1 from ${clinicalRecordCorrections} where ${clinicalRecordCorrections.practiceId} = ${ctx.practiceId} and ${clinicalRecordCorrections.soapNoteId} = ${soapNotes.id})`,
            ),
          )
          .limit(1);
        if (finalized)
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "This visit already has a signed SOAP note. Review it online.",
          });
        const draft = await getAppointmentSoapDraft(ctx.db, {
          practiceId: ctx.practiceId,
          patientId: patient.id,
          appointmentId: appointment.id,
        });
        visit = {
          appointmentId: appointment.id,
          startTime: appointment.startTime.toISOString(),
          noteId: draft?.id ?? null,
          revision: draft?.revision ?? 0,
          sections: draft ? sections(draft) : { ...EMPTY_SOAP },
        };
      }
      return {
        identity: ctx.offlineIdentity,
        chart: chartSnapshotSchema.parse({
          patient,
          capturedAt: ctx.offlineIdentity.authorizedAt,
          allergies,
          notes: notes.map((note) => ({ ...note, at: note.at.toISOString() })),
          soapHistory: history.map((note) => ({
            at: (note.finalizedAt ?? note.createdAt).toISOString(),
            author: note.authorName,
            sections: sections(note),
          })),
          visit,
        }),
      };
    }),
  // Kept available when preparation is disabled so existing device drafts can
  // still be recovered. Standard role, subscription, recovery-hold and visit
  // lifecycle checks all apply; this endpoint cannot finalize a record.
  saveSoapDraft: offlineProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        practiceId: z.string().uuid(),
        request: soapRequestSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId !== ctx.user.id || input.practiceId !== ctx.practiceId)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Sign in as the person who prepared this workspace.",
        });
      try {
        return await ctx.db.transaction(async (tx) => {
          const result = await saveAppointmentSoapDraft(
            tx as unknown as Database,
            {
              practiceId: ctx.practiceId,
              patientId: input.request.patientId,
              appointmentId: input.request.appointmentId,
              noteId: input.request.noteId ?? undefined,
              expectedRevision: input.request.expectedRevision,
              actor: { id: ctx.user.id, name: ctx.user.name },
              sections: input.request.sections,
            },
          );
          if (result.outcome !== "saved")
            return {
              outcome: result.outcome,
              sections: sections(
                result.outcome === "conflict" ? result.draft : result.note,
              ),
            };
          await tx.insert(auditLog).values({
            practiceId: ctx.practiceId,
            userId: ctx.user.id,
            action: "offline_draft_saved",
            entityType: "soapNotes",
            entityId: result.draft.id,
            changes: {
              patientId: result.draft.patientId,
              appointmentId: result.draft.appointmentId,
              revision: result.draft.revision,
            },
            ipAddress: ctx.ip ?? null,
          });
          return {
            outcome: "saved" as const,
            noteId: result.draft.id,
            revision: result.draft.revision,
          };
        });
      } catch (error) {
        if (error instanceof SoapLifecycleError)
          throw new TRPCError({ code: error.code, message: error.message });
        throw error;
      }
    }),
});
