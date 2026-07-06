import { z } from "zod";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  insurancePolicies,
  insuranceClaims,
  clients,
  patients,
  invoices,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  clinicalDateInput,
  clinicalTextInput,
  compareClinicalDateInputs,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import { moneyToCents } from "@/lib/billing/invoice-balance";
import { listOffsetInput } from "./pagination";

const claimStatuses = [
  "draft",
  "submitted",
  "in_review",
  "approved",
  "denied",
  "paid",
] as const;

type ClaimStatus = (typeof claimStatuses)[number];

const claimStatusTransitions: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ["draft", "submitted"],
  submitted: ["submitted", "in_review", "approved", "denied"],
  in_review: ["in_review", "approved", "denied"],
  approved: ["approved", "paid"],
  denied: ["denied"],
  paid: ["paid"],
};

const moneyInput = z.string().trim().refine((value) => {
  return /^\d{1,8}(?:\.\d{1,2})?$/.test(value);
}, "Amount must be a valid currency amount.");

const positiveMoneyInput = moneyInput.refine(
  (value) => Number(value) > 0,
  "Amount must be positive."
);

const policyMoneyInput = moneyInput.optional();

const policyMutableInput = {
  providerName: clinicalTextInput("Provider name", 255),
  policyNumber: optionalClinicalTextInput("Policy number", 128),
  groupNumber: optionalClinicalTextInput("Group number", 128),
  phoneNumber: optionalClinicalTextInput("Phone number", 32),
  coverageType: optionalClinicalTextInput("Coverage type", 128),
  deductible: policyMoneyInput,
  coveragePercent: z.number().int().min(0).max(100).optional(),
  maxAnnualBenefit: policyMoneyInput,
  effectiveDate: clinicalDateInput("Effective date").optional(),
  expirationDate: clinicalDateInput("Expiration date").optional(),
  notes: optionalClinicalTextInput("Notes", 2000),
};

const policyInput = z
  .object({
    clientId: z.string().uuid(),
    patientId: z.string().uuid(),
    ...policyMutableInput,
  })
  .superRefine((input, ctx) => {
    if (
      input.effectiveDate &&
      input.expirationDate &&
      compareClinicalDateInputs(input.effectiveDate, input.expirationDate) > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expirationDate"],
        message: "Effective date must be on or before expiration date.",
      });
    }
  });

const policyUpdateInput = z.object({
  id: z.string().uuid(),
  providerName: policyMutableInput.providerName.optional(),
  policyNumber: policyMutableInput.policyNumber,
  groupNumber: policyMutableInput.groupNumber,
  phoneNumber: policyMutableInput.phoneNumber,
  coverageType: policyMutableInput.coverageType,
  deductible: policyMutableInput.deductible,
  coveragePercent: policyMutableInput.coveragePercent,
  maxAnnualBenefit: policyMutableInput.maxAnnualBenefit,
  effectiveDate: policyMutableInput.effectiveDate,
  expirationDate: policyMutableInput.expirationDate,
  notes: policyMutableInput.notes,
});

const claimsListInput = z.object({
  status: z.enum(claimStatuses).optional(),
  policyId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: listOffsetInput,
});

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

async function assertPolicyTargetsBelongToPractice(
  db: Database,
  practiceId: string,
  input: {
    clientId: string;
    patientId: string;
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

async function assertClaimTargetsBelongToPractice(
  db: Database,
  practiceId: string,
  input: {
    policyId: string;
    invoiceId?: string;
  }
) {
  const [policy] = await db
    .select({
      id: insurancePolicies.id,
      clientId: insurancePolicies.clientId,
      patientId: insurancePolicies.patientId,
    })
    .from(insurancePolicies)
    .where(
      and(
        eq(insurancePolicies.id, input.policyId),
        eq(insurancePolicies.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(insurancePolicies.deletedAt)
      )
    )
    .limit(1);
  if (!policy) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Policy not found" });
  }

  if (input.invoiceId) {
    const [invoice] = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.id, input.invoiceId),
          eq(invoices.clientId, policy.clientId),
          eq(invoices.patientId, policy.patientId),
          eq(invoices.practiceId, practiceId),
          activePracticePredicate(practiceId),
          isNull(invoices.deletedAt)
        )
      )
      .limit(1);
    if (!invoice) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Invoice not found" });
    }
  }
}

async function getPolicyDateWindowForPractice(
  db: Database,
  practiceId: string,
  policyId: string
): Promise<{ effectiveDate: string | null; expirationDate: string | null }> {
  const [policy] = await db
    .select({
      effectiveDate: insurancePolicies.effectiveDate,
      expirationDate: insurancePolicies.expirationDate,
    })
    .from(insurancePolicies)
    .where(
      and(
        eq(insurancePolicies.id, policyId),
        eq(insurancePolicies.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(insurancePolicies.deletedAt)
      )
    )
    .limit(1);

  if (!policy) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Policy not found" });
  }

  return policy;
}

function assertValidPolicyDateWindow(
  effectiveDate?: string | null,
  expirationDate?: string | null
) {
  if (
    effectiveDate &&
    expirationDate &&
    compareClinicalDateInputs(effectiveDate, expirationDate) > 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Effective date must be on or before expiration date.",
    });
  }
}

function assertClaimStatusTransition(current: ClaimStatus, next: ClaimStatus) {
  if (claimStatusTransitions[current].includes(next)) return;

  throw new TRPCError({
    code: "BAD_REQUEST",
    message: `Cannot change insurance claim status from ${current} to ${next}.`,
  });
}

async function getClaimForStatusUpdate(
  db: Database,
  practiceId: string,
  claimId: string
): Promise<{
  status: ClaimStatus;
  claimAmount: string;
  approvedAmount: string | null;
  deniedReason: string | null;
  submittedAt: Date | null;
  resolvedAt: Date | null;
}> {
  const [claim] = await db
    .select({
      status: insuranceClaims.status,
      claimAmount: insuranceClaims.claimAmount,
      approvedAmount: insuranceClaims.approvedAmount,
      deniedReason: insuranceClaims.deniedReason,
      submittedAt: insuranceClaims.submittedAt,
      resolvedAt: insuranceClaims.resolvedAt,
    })
    .from(insuranceClaims)
    .where(
      and(
        eq(insuranceClaims.id, claimId),
        eq(insuranceClaims.practiceId, practiceId),
        activePracticePredicate(practiceId),
        isNull(insuranceClaims.deletedAt)
      )
    )
    .limit(1);

  if (!claim) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Claim not found" });
  }

  return claim;
}

function assertValidClaimResolution(input: {
  status: ClaimStatus;
  claimAmount: string;
  approvedAmount?: string | null;
  deniedReason?: string | null;
}) {
  if (
    input.approvedAmount !== undefined &&
    input.approvedAmount !== null &&
    moneyToCents(input.approvedAmount) > moneyToCents(input.claimAmount)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Approved amount cannot exceed the claim amount.",
    });
  }

  if (
    (input.status === "approved" || input.status === "paid") &&
    moneyToCents(input.approvedAmount) <= 0
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Approved claims require a positive approved amount.",
    });
  }

  if (input.status === "denied" && !input.deniedReason?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Denied claims require a denial reason.",
    });
  }
}

export const insuranceRouter = createRouter({
  listPolicies: protectedProcedure
    .input(
      z.object({
        patientId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const conditions: ReturnType<typeof eq>[] = [
        eq(insurancePolicies.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(insurancePolicies.deletedAt),
      ];

      if (input.patientId) {
        conditions.push(eq(insurancePolicies.patientId, input.patientId));
      }

      return ctx.db
        .select({
          id: insurancePolicies.id,
          providerName: insurancePolicies.providerName,
          policyNumber: insurancePolicies.policyNumber,
          groupNumber: insurancePolicies.groupNumber,
          phoneNumber: insurancePolicies.phoneNumber,
          coverageType: insurancePolicies.coverageType,
          deductible: insurancePolicies.deductible,
          coveragePercent: insurancePolicies.coveragePercent,
          maxAnnualBenefit: insurancePolicies.maxAnnualBenefit,
          effectiveDate: insurancePolicies.effectiveDate,
          expirationDate: insurancePolicies.expirationDate,
          notes: insurancePolicies.notes,
          createdAt: insurancePolicies.createdAt,
          clientFirstName: clients.firstName,
          clientLastName: clients.lastName,
          patientName: patients.name,
        })
        .from(insurancePolicies)
        .leftJoin(
          clients,
          and(
            eq(insurancePolicies.clientId, clients.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .leftJoin(
          patients,
          and(
            eq(insurancePolicies.patientId, patients.id),
            eq(patients.clientId, insurancePolicies.clientId),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        )
        .where(and(...conditions))
        .orderBy(desc(insurancePolicies.createdAt));
    }),

  createPolicy: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(policyInput)
    .mutation(async ({ ctx, input }) => {
      assertValidPolicyDateWindow(input.effectiveDate, input.expirationDate);
      await assertActivePractice(ctx.db, ctx.practiceId);
      await assertPolicyTargetsBelongToPractice(ctx.db, ctx.practiceId, input);

      const [policy] = await ctx.db
        .insert(insurancePolicies)
        .values({
          practiceId: ctx.practiceId,
          clientId: input.clientId,
          patientId: input.patientId,
          providerName: input.providerName,
          policyNumber: input.policyNumber ?? null,
          groupNumber: input.groupNumber ?? null,
          phoneNumber: input.phoneNumber ?? null,
          coverageType: input.coverageType ?? null,
          deductible: input.deductible ?? null,
          coveragePercent: input.coveragePercent ?? null,
          maxAnnualBenefit: input.maxAnnualBenefit ?? null,
          effectiveDate: input.effectiveDate ?? null,
          expirationDate: input.expirationDate ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      return policy!;
    }),

  updatePolicy: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(policyUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const { id, ...updates } = input;
      const setValues: Record<string, any> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) {
          setValues[key] = value;
        }
      }

      if (Object.keys(setValues).length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No fields to update",
        });
      }

      assertValidPolicyDateWindow(updates.effectiveDate, updates.expirationDate);
      await assertActivePractice(ctx.db, ctx.practiceId);

      const existing = await getPolicyDateWindowForPractice(
        ctx.db,
        ctx.practiceId,
        id
      );
      const nextEffectiveDate =
        updates.effectiveDate !== undefined
          ? updates.effectiveDate
          : existing.effectiveDate;
      const nextExpirationDate =
        updates.expirationDate !== undefined
          ? updates.expirationDate
          : existing.expirationDate;
      assertValidPolicyDateWindow(nextEffectiveDate, nextExpirationDate);

      const [policy] = await ctx.db
        .update(insurancePolicies)
        .set(setValues)
        .where(
          and(
            eq(insurancePolicies.id, id),
            eq(insurancePolicies.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(insurancePolicies.deletedAt),
            sql`${insurancePolicies.effectiveDate} is not distinct from ${existing.effectiveDate}`,
            sql`${insurancePolicies.expirationDate} is not distinct from ${existing.expirationDate}`
          )
        )
        .returning();

      if (!policy) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Policy changed while updating. Refresh and try again.",
        });
      }
      return policy;
    }),

  listClaims: protectedProcedure
    .input(claimsListInput)
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const conditions: ReturnType<typeof eq>[] = [
        eq(insuranceClaims.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(insuranceClaims.deletedAt),
      ];

      if (input.status) {
        conditions.push(eq(insuranceClaims.status, input.status));
      }

      if (input.policyId) {
        conditions.push(eq(insuranceClaims.policyId, input.policyId));
      }

      const [items, countResult] = await Promise.all([
        ctx.db
          .select({
            id: insuranceClaims.id,
            claimNumber: insuranceClaims.claimNumber,
            status: insuranceClaims.status,
            claimAmount: insuranceClaims.claimAmount,
            approvedAmount: insuranceClaims.approvedAmount,
            deniedReason: insuranceClaims.deniedReason,
            submittedAt: insuranceClaims.submittedAt,
            resolvedAt: insuranceClaims.resolvedAt,
            notes: insuranceClaims.notes,
            createdAt: insuranceClaims.createdAt,
            providerName: insurancePolicies.providerName,
            policyNumber: insurancePolicies.policyNumber,
          })
          .from(insuranceClaims)
          .leftJoin(
            insurancePolicies,
            and(
              eq(insuranceClaims.policyId, insurancePolicies.id),
              eq(insurancePolicies.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(insurancePolicies.deletedAt)
            )
          )
          .where(and(...conditions))
          .orderBy(desc(insuranceClaims.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(insuranceClaims)
          .where(and(...conditions)),
      ]);

      return {
        items,
        total: Number(countResult[0]?.count ?? 0),
      };
    }),

  createClaim: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(
      z.object({
        policyId: z.string().uuid(),
        invoiceId: z.string().uuid().optional(),
        claimNumber: optionalClinicalTextInput("Claim number", 128),
        claimAmount: positiveMoneyInput,
        notes: optionalClinicalTextInput("Notes", 2000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      await assertClaimTargetsBelongToPractice(ctx.db, ctx.practiceId, input);

      const [claim] = await ctx.db
        .insert(insuranceClaims)
        .values({
          practiceId: ctx.practiceId,
          policyId: input.policyId,
          invoiceId: input.invoiceId ?? null,
          claimNumber: input.claimNumber ?? null,
          claimAmount: input.claimAmount,
          status: "draft",
          notes: input.notes ?? null,
        })
        .returning();
      return claim!;
    }),

  updateClaimStatus: protectedProcedure
    .use(requireRole("admin", "front_desk"))
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(claimStatuses),
        approvedAmount: moneyInput.optional(),
        deniedReason: optionalClinicalTextInput("Denied reason", 2000),
        notes: optionalClinicalTextInput("Notes", 2000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx.db, ctx.practiceId);
      const existing = await getClaimForStatusUpdate(
        ctx.db,
        ctx.practiceId,
        input.id
      );
      assertClaimStatusTransition(existing.status, input.status);

      const nextApprovedAmount =
        input.approvedAmount !== undefined
          ? input.approvedAmount
          : existing.approvedAmount;
      const nextDeniedReason =
        input.deniedReason !== undefined
          ? input.deniedReason
          : existing.deniedReason;
      assertValidClaimResolution({
        status: input.status,
        claimAmount: existing.claimAmount,
        approvedAmount: nextApprovedAmount,
        deniedReason: nextDeniedReason,
      });

      const updates: Record<string, any> = { status: input.status };

      // Auto-set submittedAt when status moves to "submitted"
      if (input.status === "submitted" && !existing.submittedAt) {
        updates.submittedAt = new Date();
      }

      // Auto-set resolvedAt when claim reaches a terminal status
      if (
        ["approved", "denied", "paid"].includes(input.status) &&
        !existing.resolvedAt
      ) {
        updates.resolvedAt = new Date();
      }

      if (input.approvedAmount !== undefined) {
        updates.approvedAmount = input.approvedAmount;
      }

      if (input.deniedReason !== undefined) {
        updates.deniedReason = input.deniedReason;
      }

      if (input.notes !== undefined) {
        updates.notes = input.notes;
      }

      const [claim] = await ctx.db
        .update(insuranceClaims)
        .set(updates)
        .where(
          and(
            eq(insuranceClaims.id, input.id),
            eq(insuranceClaims.practiceId, ctx.practiceId),
            eq(insuranceClaims.status, existing.status),
            activePracticePredicate(ctx.practiceId),
            sql`${insuranceClaims.approvedAmount} is not distinct from ${existing.approvedAmount}`,
            isNull(insuranceClaims.deletedAt)
          )
        )
        .returning();

      if (!claim) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Claim changed while updating. Refresh and try again.",
        });
      }
      return claim;
    }),
});
