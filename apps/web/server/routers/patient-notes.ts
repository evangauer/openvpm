import { z } from "zod";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  auditLog,
  clinicalNotes,
  patients,
  practices,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { isUuid } from "@/lib/compat/shared/validation";
import {
  PATIENT_NOTE_MAX_LENGTH,
  PATIENT_NOTE_TYPES,
} from "@/lib/records/patient-note-policy";

const uuidInput = z.string().refine(isUuid, "Invalid UUID");

async function lockPatient(
  db: Database,
  practiceId: string,
  patientId: string,
) {
  const [patient] = await db
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(
      practices,
      and(eq(practices.id, patients.practiceId), isNull(practices.deletedAt)),
    )
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .for("share", { of: patients });
  if (!patient)
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found." });
}

export const patientNotesRouter = createRouter({
  list: protectedProcedure
    .use(requireRole("admin", "veterinarian", "technician", "viewer"))
    .input(
      z.object({
        patientId: uuidInput,
        cursor: z
          .object({ createdAt: z.date(), id: uuidInput })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await lockPatient(ctx.db, ctx.practiceId, input.patientId);
      const rows = await ctx.db
        .select({
          id: clinicalNotes.id,
          noteType: clinicalNotes.noteType,
          content: clinicalNotes.content,
          createdAt: clinicalNotes.createdAt,
          authorName: users.name,
        })
        .from(clinicalNotes)
        .leftJoin(
          users,
          and(
            eq(users.id, clinicalNotes.authorId),
            eq(users.practiceId, ctx.practiceId),
          ),
        )
        .where(
          and(
            eq(clinicalNotes.practiceId, ctx.practiceId),
            eq(clinicalNotes.patientId, input.patientId),
            eq(clinicalNotes.isChartNote, true),
            isNull(clinicalNotes.deletedAt),
            input.cursor
              ? or(
                  lt(clinicalNotes.createdAt, input.cursor.createdAt),
                  and(
                    eq(clinicalNotes.createdAt, input.cursor.createdAt),
                    lt(clinicalNotes.id, input.cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(clinicalNotes.createdAt), desc(clinicalNotes.id))
        .limit(26);
      const items = rows.slice(0, 25);
      const last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > 25 && last
            ? { createdAt: last.createdAt, id: last.id }
            : undefined,
      };
    }),
  create: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        patientId: uuidInput,
        operationId: uuidInput,
        noteType: z.enum(PATIENT_NOTE_TYPES),
        content: z
          .string()
          .trim()
          .min(1, "Enter a note.")
          .max(PATIENT_NOTE_MAX_LENGTH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        // The request already runs in a tenant transaction. The patient lock also
        // serializes this append against patient deletion and merge operations.
        await lockPatient(ctx.db, ctx.practiceId, input.patientId);
        const [note] = await ctx.db
          .insert(clinicalNotes)
          .values({
            id: input.operationId,
            practiceId: ctx.practiceId,
            patientId: input.patientId,
            authorId: ctx.user.id,
            noteType: input.noteType,
            content: input.content,
            isChartNote: true,
          })
          .onConflictDoNothing({ target: clinicalNotes.id })
          .returning();
        if (!note) {
          const [existing] = await ctx.db
            .select()
            .from(clinicalNotes)
            .where(
              and(
                eq(clinicalNotes.id, input.operationId),
                eq(clinicalNotes.practiceId, ctx.practiceId),
                eq(clinicalNotes.patientId, input.patientId),
                eq(clinicalNotes.authorId, ctx.user.id),
                eq(clinicalNotes.isChartNote, true),
                isNull(clinicalNotes.deletedAt),
              ),
            )
            .limit(1);
          if (
            !existing ||
            existing.content !== input.content ||
            existing.noteType !== input.noteType
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This save was already used for a different note. Reload the chart before trying again.",
            });
          }
          return existing;
        }
        await ctx.db.insert(auditLog).values({
          practiceId: ctx.practiceId,
          userId: ctx.user.id,
          action: "created",
          entityType: "clinical_note",
          entityId: note.id,
          changes: { patientId: input.patientId, noteType: input.noteType },
        });
        return note;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        // A driver error can contain the full pasted note in query parameters.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to save the chart note. Please retry.",
        });
      }
    }),
});
