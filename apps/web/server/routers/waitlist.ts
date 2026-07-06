import { z } from "zod";
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  appointmentWaitlist,
  clients,
  patients,
  appointmentTypes,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { matchWaitlist, type WaitlistEntry } from "@/lib/scheduling/waitlist";
import { clinicalDateInput } from "@/lib/records/clinical-inputs";

const manageRole = requireRole("admin", "veterinarian", "front_desk");
const waitlistDateInput = clinicalDateInput("Waitlist date");
const waitlistStatusValues = ["waiting", "scheduled", "cancelled"] as const;
type WaitlistStatus = (typeof waitlistStatusValues)[number];
const waitlistNotesInput = z
  .string()
  .trim()
  .max(1000, "Waitlist notes must be at most 1000 characters.")
  .optional()
  .transform((value) => value || undefined);

function activePracticeWhere(practiceId: string) {
  return and(eq(practices.id, practiceId), isNull(practices.deletedAt));
}

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

function practiceNotFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
}

async function assertActivePractice(db: Database, practiceId: string) {
  const [practice] = await db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

async function assertWaitlistTargetsBelongToPractice(
  db: Database,
  practiceId: string,
  input: {
    clientId: string;
    patientId?: string;
    typeId?: string;
  }
) {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, input.clientId),
        eq(clients.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(clients.deletedAt)
      )
    )
    .limit(1);
  if (!client) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
  }

  if (input.patientId) {
    const [patient] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(
        and(
          eq(patients.id, input.patientId),
          eq(patients.clientId, input.clientId),
          eq(patients.practiceId, practiceId),
          activePracticePredicate(practiceId),
          isNull(patients.deletedAt)
        )
      )
      .limit(1);
    if (!patient) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
    }
  }

  if (input.typeId) {
    const [type] = await db
      .select({ id: appointmentTypes.id })
      .from(appointmentTypes)
      .where(
        and(
          eq(appointmentTypes.id, input.typeId),
          eq(appointmentTypes.practiceId, practiceId),
          activePracticePredicate(practiceId),
          isNull(appointmentTypes.deletedAt)
        )
      )
      .limit(1);
    if (!type) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Appointment type not found",
      });
    }
  }
}

function assertValidDateWindow(preferredFrom?: string, preferredTo?: string) {
  if (preferredFrom && preferredTo && preferredFrom > preferredTo) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Preferred start date must be on or before preferred end date.",
    });
  }
}

function canTransitionWaitlistStatus(
  current: WaitlistStatus,
  next: WaitlistStatus
): boolean {
  if (current === next) return true;
  if (current === "waiting") return next === "scheduled" || next === "cancelled";
  return false;
}

/** Join the display fields the UI needs alongside the matcher fields. */
function selectShape() {
  return {
    id: appointmentWaitlist.id,
    status: appointmentWaitlist.status,
    typeId: appointmentWaitlist.typeId,
    preferredFrom: appointmentWaitlist.preferredFrom,
    preferredTo: appointmentWaitlist.preferredTo,
    notes: appointmentWaitlist.notes,
    createdAt: appointmentWaitlist.createdAt,
    clientFirstName: clients.firstName,
    clientLastName: clients.lastName,
    clientPhone: clients.phone,
    patientName: patients.name,
    typeName: appointmentTypes.name,
  };
}

export const waitlistRouter = createRouter({
  list: protectedProcedure
    .input(
      z
        .object({ status: z.enum(waitlistStatusValues).default("waiting") })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const status = input?.status ?? "waiting";
      return ctx.db
        .select(selectShape())
        .from(appointmentWaitlist)
        .leftJoin(
          clients,
          and(
            eq(appointmentWaitlist.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          patients,
          and(
            eq(appointmentWaitlist.patientId, patients.id),
            eq(patients.clientId, appointmentWaitlist.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          appointmentTypes,
          and(
            eq(appointmentWaitlist.typeId, appointmentTypes.id),
            eq(appointmentTypes.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .where(
          and(
            eq(appointmentWaitlist.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(appointmentWaitlist.status, status),
            isNull(appointmentWaitlist.deletedAt)
          )
        )
        .orderBy(asc(appointmentWaitlist.createdAt));
    }),

  add: protectedProcedure
    .use(manageRole)
    .input(
      z.object({
        clientId: z.string().uuid(),
        patientId: z.string().uuid().optional(),
        typeId: z.string().uuid().optional(),
        preferredFrom: waitlistDateInput.optional(),
        preferredTo: waitlistDateInput.optional(),
        notes: waitlistNotesInput,
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertValidDateWindow(input.preferredFrom, input.preferredTo);
      await assertActivePractice(ctx.db, ctx.practiceId);
      await assertWaitlistTargetsBelongToPractice(ctx.db, ctx.practiceId, input);

      const [row] = await ctx.db
        .insert(appointmentWaitlist)
        .values({
          practiceId: ctx.practiceId,
          clientId: input.clientId,
          patientId: input.patientId ?? null,
          typeId: input.typeId ?? null,
          preferredFrom: input.preferredFrom ?? null,
          preferredTo: input.preferredTo ?? null,
          notes: input.notes ?? null,
          createdBy: ctx.user.id,
        })
        .returning();
      return row!;
    }),

  setStatus: protectedProcedure
    .use(manageRole)
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(waitlistStatusValues),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [current] = await ctx.db
        .select({
          id: appointmentWaitlist.id,
          status: appointmentWaitlist.status,
        })
        .from(appointmentWaitlist)
        .where(
          and(
            eq(appointmentWaitlist.id, input.id),
            eq(appointmentWaitlist.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointmentWaitlist.deletedAt)
          )
        )
        .limit(1);

      if (!current) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Waitlist entry not found",
        });
      }

      if (!canTransitionWaitlistStatus(current.status, input.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot change waitlist status from ${current.status} to ${input.status}.`,
        });
      }

      const [updated] = await ctx.db
        .update(appointmentWaitlist)
        .set({ status: input.status })
        .where(
          and(
            eq(appointmentWaitlist.id, input.id),
            eq(appointmentWaitlist.practiceId, ctx.practiceId),
            eq(appointmentWaitlist.status, current.status),
            activePracticePredicate(ctx.practiceId),
            isNull(appointmentWaitlist.deletedAt)
          )
        )
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "Waitlist status changed. Refresh and try again.",
        });
      }
      return updated;
    }),

  /**
   * When a slot opens up (e.g. a cancellation), find waiting clients who fit
   * the freed date + appointment type, oldest request first.
   */
  matchesForSlot: protectedProcedure
    .input(
      z.object({
        date: waitlistDateInput,
        typeId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const rows = await ctx.db
        .select(selectShape())
        .from(appointmentWaitlist)
        .leftJoin(
          clients,
          and(
            eq(appointmentWaitlist.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          patients,
          and(
            eq(appointmentWaitlist.patientId, patients.id),
            eq(patients.clientId, appointmentWaitlist.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .leftJoin(
          appointmentTypes,
          and(
            eq(appointmentWaitlist.typeId, appointmentTypes.id),
            eq(appointmentTypes.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(appointmentTypes.deletedAt)
          )
        )
        .where(
          and(
            eq(appointmentWaitlist.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            eq(appointmentWaitlist.status, "waiting"),
            isNull(appointmentWaitlist.deletedAt)
          )
        );

      const entries: WaitlistEntry[] = rows.map((r) => ({
        id: r.id,
        status: r.status,
        typeId: r.typeId,
        preferredFrom: r.preferredFrom,
        preferredTo: r.preferredTo,
        createdAt: r.createdAt,
      }));
      // Run the matcher once, then map back to the joined display rows in the
      // matcher's FIFO order.
      const byId = new Map(rows.map((r) => [r.id, r]));
      return matchWaitlist(entries, { date: input.date, typeId: input.typeId })
        .map((e) => byId.get(e.id))
        .filter((r): r is (typeof rows)[number] => Boolean(r));
    }),
});
