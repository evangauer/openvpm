import { z } from "zod";
import { eq, and, isNull, gte, lte, sql, desc, asc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  controlledSubstanceLog,
  patients,
  practices,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { alias } from "drizzle-orm/pg-core";
import {
  clinicalDateInput,
  clinicalTextInput,
  compareClinicalDateInputs,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import {
  CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH,
  CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH,
  isControlledSubstanceQuantityInputValid,
} from "@/lib/controlled-substances/policy";
import { listOffsetInput } from "./pagination";
import { dateInputDayUtcRange } from "@/lib/date-input";

type ControlledSubstancesDb = Pick<Database, "execute" | "select">;

type ControlledSubstancesContext = {
  db: ControlledSubstancesDb;
  practiceId: string;
};

const CONTROLLED_SUBSTANCE_CONSUMING_ACTIONS = [
  "administered",
  "wasted",
  "returned",
] as const;

const controlledQuantityInput = z
  .string()
  .trim()
  .refine(
    isControlledSubstanceQuantityInputValid,
    "Quantity must be a positive number with up to 3 decimal places."
  );

const performedAtInput = z.string().datetime({ offset: true });

const listInput = z
  .object({
    drugName: optionalClinicalTextInput(
      "Drug name",
      CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH
    ),
    startDate: clinicalDateInput("Start date").optional(),
    endDate: clinicalDateInput("End date").optional(),
    limit: z.number().int().min(1).max(100).default(25),
    offset: listOffsetInput,
  })
  .superRefine((input, ctx) => {
    if (
      input.startDate &&
      input.endDate &&
      compareClinicalDateInputs(input.endDate, input.startDate) < 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "End date must be on or after start date.",
      });
    }
  });

const summaryInput = z
  .object({
    startDate: clinicalDateInput("Start date").optional(),
    endDate: clinicalDateInput("End date").optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.startDate &&
      input.endDate &&
      compareClinicalDateInputs(input.endDate, input.startDate) < 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "End date must be on or after start date.",
      });
    }
  });

function startOfClinicalDate(
  value: string,
  timeZone?: string | null
): Date {
  if (timeZone) return dateInputDayUtcRange(value, timeZone).start;
  return new Date(`${value}T00:00:00.000Z`);
}

function endOfClinicalDate(value: string, timeZone?: string | null): Date {
  if (timeZone) {
    const { end } = dateInputDayUtcRange(value, timeZone);
    return new Date(end.getTime() - 1);
  }
  return new Date(`${value}T23:59:59.999Z`);
}

function controlledSubstanceQuantityMillis(value: string | null | undefined) {
  const trimmed = value?.trim() || "0";
  const [wholePart = "0", fractionPart = ""] = trimmed.split(".");
  return (
    BigInt(wholePart) * 1000n +
    BigInt((fractionPart + "000").slice(0, 3))
  );
}

function formatControlledSubstanceQuantity(millis: bigint) {
  const sign = millis < 0n ? "-" : "";
  const absolute = millis < 0n ? -millis : millis;
  const whole = absolute / 1000n;
  const fraction = (absolute % 1000n).toString().padStart(3, "0");
  const trimmedFraction = fraction.replace(/0+$/, "");
  return `${sign}${whole.toString()}${
    trimmedFraction ? `.${trimmedFraction}` : ""
  }`;
}

function isControlledSubstanceConsumingAction(
  action: "received" | "administered" | "wasted" | "returned"
) {
  return CONTROLLED_SUBSTANCE_CONSUMING_ACTIONS.includes(
    action as (typeof CONTROLLED_SUBSTANCE_CONSUMING_ACTIONS)[number]
  );
}

function controlledSubstanceLedgerLockKey(input: {
  practiceId: string;
  drugName: string;
  unit: string;
}) {
  return `controlled-substance:${input.practiceId}:${input.drugName}:${input.unit}`;
}

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

async function assertActivePractice(ctx: ControlledSubstancesContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

async function lockControlledSubstanceLedger(
  ctx: ControlledSubstancesContext,
  input: { drugName: string; unit: string }
) {
  const lockKey = controlledSubstanceLedgerLockKey({
    practiceId: ctx.practiceId,
    drugName: input.drugName,
    unit: input.unit,
  });

  await ctx.db.execute(
    sql`select pg_advisory_xact_lock(hashtext(${lockKey}::text))`
  );
}

async function assertControlledSubstanceBalance(
  ctx: ControlledSubstancesContext,
  input: {
    action: "received" | "administered" | "wasted" | "returned";
    drugName: string;
    quantity: string;
    unit: string;
  }
) {
  if (!isControlledSubstanceConsumingAction(input.action)) return;

  const [balance] = await ctx.db
    .select({
      totalReceived: sql<string>`coalesce(sum(case when ${controlledSubstanceLog.action} = 'received' then ${controlledSubstanceLog.quantity} else 0 end), 0)`,
      totalAdministered: sql<string>`coalesce(sum(case when ${controlledSubstanceLog.action} = 'administered' then ${controlledSubstanceLog.quantity} else 0 end), 0)`,
      totalWasted: sql<string>`coalesce(sum(case when ${controlledSubstanceLog.action} = 'wasted' then ${controlledSubstanceLog.quantity} else 0 end), 0)`,
      totalReturned: sql<string>`coalesce(sum(case when ${controlledSubstanceLog.action} = 'returned' then ${controlledSubstanceLog.quantity} else 0 end), 0)`,
    })
    .from(controlledSubstanceLog)
    .where(
      and(
        eq(controlledSubstanceLog.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        eq(controlledSubstanceLog.drugName, input.drugName),
        eq(controlledSubstanceLog.unit, input.unit),
        isNull(controlledSubstanceLog.deletedAt)
      )
    )
    .limit(1);

  const available =
    controlledSubstanceQuantityMillis(balance?.totalReceived) -
    controlledSubstanceQuantityMillis(balance?.totalAdministered) -
    controlledSubstanceQuantityMillis(balance?.totalWasted) -
    controlledSubstanceQuantityMillis(balance?.totalReturned);
  const requested = controlledSubstanceQuantityMillis(input.quantity);

  if (requested > available) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Insufficient ${input.drugName} balance: ${formatControlledSubstanceQuantity(
        available
      )} ${input.unit} available.`,
    });
  }
}

async function practiceTimeZone(
  ctx: ControlledSubstancesContext
): Promise<string | null> {
  const [practice] = await ctx.db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }

  return practice.timezone ?? null;
}

async function controlledSubstanceDateRange(
  ctx: ControlledSubstancesContext,
  input: { startDate?: string; endDate?: string }
): Promise<{ start?: Date; end?: Date }> {
  if (!input.startDate && !input.endDate) return {};
  const timezone = await practiceTimeZone(ctx);

  return {
    start: input.startDate
      ? startOfClinicalDate(input.startDate, timezone)
      : undefined,
    end: input.endDate ? endOfClinicalDate(input.endDate, timezone) : undefined,
  };
}

async function assertPatientBelongsToPractice(
  ctx: ControlledSubstancesContext,
  patientId: string
) {
  const [patient] = await ctx.db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.id, patientId),
        eq(patients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(patients.deletedAt)
      )
    )
    .limit(1);

  if (!patient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found" });
  }

  return patient;
}

async function assertWitnessBelongsToPractice(
  ctx: ControlledSubstancesContext,
  userId: string
) {
  const [user] = await ctx.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(users.deletedAt)
      )
    )
    .limit(1);

  if (!user) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Witness not found" });
  }

  return user;
}

export const controlledSubstancesRouter = createRouter({
  settings: protectedProcedure.query(async ({ ctx }) => ({
    timezone: await practiceTimeZone(ctx),
  })),

  listWitnesses: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .query(async ({ ctx }) => {
      await assertActivePractice(ctx);
      return ctx.db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
        })
        .from(users)
        .where(
          and(
            eq(users.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(users.deletedAt)
          )
        )
        .orderBy(asc(users.name));
    }),

  list: protectedProcedure
    .input(listInput)
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const performer = alias(users, "performer");
      const witness = alias(users, "witness");
      const range = await controlledSubstanceDateRange(ctx, input);

      const conditions = [
        eq(controlledSubstanceLog.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(controlledSubstanceLog.deletedAt),
      ];

      if (input.drugName) {
        conditions.push(
          eq(controlledSubstanceLog.drugName, input.drugName)
        );
      }
      if (range.start) {
        conditions.push(
          gte(controlledSubstanceLog.performedAt, range.start)
        );
      }
      if (range.end) {
        conditions.push(
          lte(controlledSubstanceLog.performedAt, range.end)
        );
      }

      const [items, countResult] = await Promise.all([
        ctx.db
          .select({
            id: controlledSubstanceLog.id,
            drugName: controlledSubstanceLog.drugName,
            deaSchedule: controlledSubstanceLog.deaSchedule,
            action: controlledSubstanceLog.action,
            quantity: controlledSubstanceLog.quantity,
            unit: controlledSubstanceLog.unit,
            lotNumber: controlledSubstanceLog.lotNumber,
            notes: controlledSubstanceLog.notes,
            performedAt: controlledSubstanceLog.performedAt,
            patientId: controlledSubstanceLog.patientId,
            patientName: patients.name,
            performerName: performer.name,
            witnessName: witness.name,
          })
          .from(controlledSubstanceLog)
          .leftJoin(
            patients,
            and(
              eq(controlledSubstanceLog.patientId, patients.id),
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(patients.deletedAt)
            )
          )
          .leftJoin(
            performer,
            and(
              eq(controlledSubstanceLog.performedBy, performer.id),
              eq(performer.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          )
          .leftJoin(
            witness,
            and(
              eq(controlledSubstanceLog.witnessedBy, witness.id),
              eq(witness.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId)
            )
          )
          .where(and(...conditions))
          .orderBy(desc(controlledSubstanceLog.performedAt))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(controlledSubstanceLog)
          .where(and(...conditions)),
      ]);

      return {
        items,
        total: Number(countResult[0]?.count ?? 0),
      };
    }),

  create: protectedProcedure
    .use(requireRole("admin", "veterinarian"))
    .input(
      z.object({
        drugName: clinicalTextInput(
          "Drug name",
          CONTROLLED_SUBSTANCE_DRUG_NAME_MAX_LENGTH
        ),
        deaSchedule: z.enum(["II", "III", "IV", "V"]),
        action: z.enum(["received", "administered", "wasted", "returned"]),
        quantity: controlledQuantityInput,
        unit: clinicalTextInput("Unit", CONTROLLED_SUBSTANCE_UNIT_MAX_LENGTH),
        patientId: z.string().uuid().nullable().optional(),
        witnessedBy: z.string().uuid().nullable().optional(),
        lotNumber: optionalClinicalTextInput(
          "Lot number",
          CONTROLLED_SUBSTANCE_LOT_NUMBER_MAX_LENGTH
        ),
        notes: optionalClinicalTextInput(
          "Notes",
          CONTROLLED_SUBSTANCE_NOTES_MAX_LENGTH
        ),
        performedAt: performedAtInput.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Waste requires a witness
      if (input.action === "wasted" && !input.witnessedBy) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Controlled substance waste requires a witness.",
        });
      }

      // Administered requires a patient
      if (input.action === "administered" && !input.patientId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A patient must be specified when administering a controlled substance.",
        });
      }

      return ctx.db.transaction(async (tx) => {
        const txCtx = { db: tx, practiceId: ctx.practiceId };
        await assertActivePractice(txCtx);
        if (input.patientId) {
          await assertPatientBelongsToPractice(txCtx, input.patientId);
        }
        if (input.witnessedBy) {
          await assertWitnessBelongsToPractice(txCtx, input.witnessedBy);
        }

        await lockControlledSubstanceLedger(txCtx, input);
        await assertControlledSubstanceBalance(txCtx, input);

        const [entry] = await tx
          .insert(controlledSubstanceLog)
          .values({
            practiceId: ctx.practiceId,
            drugName: input.drugName,
            deaSchedule: input.deaSchedule,
            action: input.action,
            quantity: input.quantity,
            unit: input.unit,
            patientId: input.patientId ?? null,
            performedBy: ctx.user.id,
            witnessedBy: input.witnessedBy ?? null,
            lotNumber: input.lotNumber,
            notes: input.notes,
            performedAt: input.performedAt
              ? new Date(input.performedAt)
              : new Date(),
          })
          .returning();

        return entry!;
      });
    }),

  summary: protectedProcedure
    .input(summaryInput)
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const range = await controlledSubstanceDateRange(ctx, input);
      const conditions = [
        eq(controlledSubstanceLog.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(controlledSubstanceLog.deletedAt),
      ];

      if (range.start) {
        conditions.push(
          gte(controlledSubstanceLog.performedAt, range.start)
        );
      }
      if (range.end) {
        conditions.push(
          lte(controlledSubstanceLog.performedAt, range.end)
        );
      }

      const rows = await ctx.db
        .select({
          drugName: controlledSubstanceLog.drugName,
          unit: controlledSubstanceLog.unit,
          totalReceived: sql<string>`coalesce(sum(case when ${controlledSubstanceLog.action} = 'received' then ${controlledSubstanceLog.quantity} else 0 end), 0)`,
          totalAdministered: sql<string>`coalesce(sum(case when ${controlledSubstanceLog.action} = 'administered' then ${controlledSubstanceLog.quantity} else 0 end), 0)`,
          totalWasted: sql<string>`coalesce(sum(case when ${controlledSubstanceLog.action} = 'wasted' then ${controlledSubstanceLog.quantity} else 0 end), 0)`,
          totalReturned: sql<string>`coalesce(sum(case when ${controlledSubstanceLog.action} = 'returned' then ${controlledSubstanceLog.quantity} else 0 end), 0)`,
        })
        .from(controlledSubstanceLog)
        .where(and(...conditions))
        .groupBy(controlledSubstanceLog.drugName, controlledSubstanceLog.unit)
        .orderBy(controlledSubstanceLog.drugName);

      return rows;
    }),
});
