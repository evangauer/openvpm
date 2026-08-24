import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  appointments,
  clients,
  patients,
  practices,
  products,
  services,
  visitTreatmentPlanRevisionLines,
  visitTreatmentPlanRevisions,
  visitTreatmentPlans,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";

import { centsToMoney, moneyToCents } from "@/lib/billing/invoice-balance";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import { clinicalTextInput } from "@/lib/records/clinical-inputs";
import {
  escapeTemplateCatalogLike,
  TEMPLATE_CATALOG_RESULT_LIMIT,
  TEMPLATE_CATALOG_SEARCH_MAX_LENGTH,
} from "@/lib/templates/catalog-search";
import {
  canonicalQuantity,
  priceTreatmentPlanLines,
  TREATMENT_PLAN_MAX_ITEMS,
  TREATMENT_PLAN_QUANTITY_PATTERN,
  treatmentPlanAuthoringEnabled,
  treatmentPlanOperationHash,
  type PricedTreatmentPlanLine,
  type TreatmentPlanCatalogItemInput,
} from "@/lib/treatment-plan-authoring/policy";
import { createRouter, protectedProcedure, requireRole } from "../trpc";

const clinicalRole = requireRole("admin", "veterinarian", "technician");

const catalogItemInput = z.object({
  itemType: z.enum(["service", "product"]),
  itemId: z.string().uuid(),
  quantity: z
    .string()
    .trim()
    .regex(
      TREATMENT_PLAN_QUANTITY_PATTERN,
      "Quantity must be positive with at most three decimal places.",
    )
    .refine(
      (value) => canonicalQuantity(value) !== "0.000",
      "Quantity must be greater than zero.",
    )
    .transform(canonicalQuantity),
});

const planItemsInput = z
  .array(catalogItemInput)
  .min(1, "A treatment plan must contain at least one line.")
  .max(
    TREATMENT_PLAN_MAX_ITEMS,
    `Treatment plans can contain at most ${TREATMENT_PLAN_MAX_ITEMS} lines.`,
  );

const createPlanInput = z.object({
  operationId: z.string().uuid(),
  clientId: z.string().uuid(),
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid().optional(),
  title: clinicalTextInput("Treatment plan title", 255),
  items: planItemsInput,
});

const revisePlanInput = z.object({
  operationId: z.string().uuid(),
  planId: z.string().uuid(),
  expectedRevisionNumber: z.number().int().min(1),
  items: planItemsInput,
});

const planContextInput = z.object({
  clientId: z.string().uuid(),
  patientId: z.string().uuid(),
  appointmentId: z.string().uuid(),
});

const quotePlanInput = planContextInput.extend({ items: planItemsInput });

type TreatmentPlanContextInput = {
  clientId: string;
  patientId: string;
  appointmentId?: string;
};

type TreatmentPlanTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
type TreatmentPlanDatabase = Database | TreatmentPlanTransaction;

type RevisionRow = {
  id: string;
  planId: string;
  revisionNumber: number;
  currency: string;
  subtotal: string;
  tax: string;
  total: string;
  authoredBy: string;
  operationId: string;
  operationPayloadHash: string;
  contentSha256: string;
  createdAt: Date;
};

function assertAuthoringEnabled(): void {
  if (!treatmentPlanAuthoringEnabled()) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Treatment plan authoring is not available.",
    });
  }
}

function pgErrorDetails(error: unknown): {
  code?: string;
  message?: string;
  constraint?: string;
} {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current !== "object") break;
    const row = current as Record<string, unknown>;
    if (typeof row.code === "string" && /^[0-9A-Z]{5}$/.test(row.code)) {
      return {
        code: row.code,
        message: typeof row.message === "string" ? row.message : undefined,
        constraint:
          typeof row.constraint_name === "string"
            ? row.constraint_name
            : typeof row.constraint === "string"
              ? row.constraint
              : undefined,
      };
    }
    current = row.cause;
  }
  return {};
}

function mapAuthoringDatabaseError(error: unknown): TRPCError | null {
  const pg = pgErrorDetails(error);
  if (pg.code === "40001") {
    return new TRPCError({
      code: "CONFLICT",
      message:
        "The treatment plan changed in another session. Refresh and retry.",
      cause: error,
    });
  }
  if (
    pg.code === "23505" &&
    pg.constraint?.startsWith("visit_treatment_plan")
  ) {
    return new TRPCError({
      code: "CONFLICT",
      message:
        "The treatment plan changed in another session. Refresh and retry.",
      cause: error,
    });
  }
  if (
    pg.code === "23514" &&
    (pg.message ===
      "Treatment plan revision number is stale or non-sequential" ||
      pg.message === "Sealed treatment plan revision lines are immutable")
  ) {
    return new TRPCError({
      code: "CONFLICT",
      message:
        "The treatment plan changed in another session. Refresh and retry.",
      cause: error,
    });
  }
  if (
    pg.code === "23503" &&
    pg.message ===
      "Treatment plan is missing, closed, or outside the active practice"
  ) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This treatment plan is no longer open for revision.",
      cause: error,
    });
  }
  return null;
}

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1 from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

async function readRevisionByOperation(
  database: TreatmentPlanDatabase,
  practiceId: string,
  operationId: string,
): Promise<RevisionRow | undefined> {
  const [revision] = await database
    .select({
      id: visitTreatmentPlanRevisions.id,
      planId: visitTreatmentPlanRevisions.planId,
      revisionNumber: visitTreatmentPlanRevisions.revisionNumber,
      currency: visitTreatmentPlanRevisions.currency,
      subtotal: visitTreatmentPlanRevisions.subtotal,
      tax: visitTreatmentPlanRevisions.tax,
      total: visitTreatmentPlanRevisions.total,
      authoredBy: visitTreatmentPlanRevisions.authoredBy,
      operationId: visitTreatmentPlanRevisions.operationId,
      operationPayloadHash: visitTreatmentPlanRevisions.operationPayloadHash,
      contentSha256: visitTreatmentPlanRevisions.contentSha256,
      createdAt: visitTreatmentPlanRevisions.createdAt,
    })
    .from(visitTreatmentPlanRevisions)
    .where(
      and(
        eq(visitTreatmentPlanRevisions.practiceId, practiceId),
        eq(visitTreatmentPlanRevisions.operationId, operationId),
        activePracticePredicate(practiceId),
      ),
    )
    .limit(1);
  return revision;
}

async function readPlanByOperation(
  database: TreatmentPlanDatabase,
  practiceId: string,
  operationId: string,
) {
  const [plan] = await database
    .select({
      id: visitTreatmentPlans.id,
      operationPayloadHash: visitTreatmentPlans.operationPayloadHash,
    })
    .from(visitTreatmentPlans)
    .where(
      and(
        eq(visitTreatmentPlans.practiceId, practiceId),
        eq(visitTreatmentPlans.operationId, operationId),
        activePracticePredicate(practiceId),
      ),
    )
    .limit(1);
  return plan;
}

function exactReplay(
  revision: RevisionRow | undefined,
  planId: string,
  payloadHash: string,
): RevisionRow | null {
  if (!revision) return null;
  if (
    revision.planId !== planId ||
    revision.operationPayloadHash !== payloadHash
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This operation id was already used for different treatment-plan content.",
    });
  }
  return revision;
}

async function assertCreateContext(
  database: TreatmentPlanDatabase,
  practiceId: string,
  input: TreatmentPlanContextInput,
) {
  const [practice] = await database
    .select({
      currency: practices.currency,
      taxRatePercent: practices.taxRatePercent,
    })
    .from(practices)
    .where(and(eq(practices.id, practiceId), isNull(practices.deletedAt)))
    .limit(1);
  if (!practice) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Practice not found" });
  }

  const [patient] = await database
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(
      clients,
      and(
        eq(clients.id, patients.clientId),
        eq(clients.practiceId, patients.practiceId),
        isNull(clients.deletedAt),
      ),
    )
    .where(
      and(
        eq(patients.id, input.patientId),
        eq(patients.clientId, input.clientId),
        eq(patients.practiceId, practiceId),
        isNull(patients.deletedAt),
      ),
    )
    .limit(1);
  if (!patient) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Patient and client context not found.",
    });
  }

  if (input.appointmentId) {
    const [appointment] = await database
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.id, input.appointmentId),
          eq(appointments.practiceId, practiceId),
          eq(appointments.patientId, input.patientId),
          eq(appointments.clientId, input.clientId),
          isNull(appointments.deletedAt),
        ),
      )
      .limit(1);
    if (!appointment) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Appointment context not found.",
      });
    }
  }

  return practice;
}

function catalogResultRank(
  item: { name: string; code: string | null },
  search: string,
): number {
  if (!search) return 4;
  const query = search.toLowerCase();
  const name = item.name.toLowerCase();
  const code = item.code?.toLowerCase() ?? "";
  if (name === query) return 0;
  if (code === query) return 1;
  if (name.startsWith(query)) return 2;
  if (code.startsWith(query)) return 3;
  return 4;
}

function compareCatalogResults(
  left: { id: string; name: string; code: string | null },
  right: { id: string; name: string; code: string | null },
  search: string,
): number {
  const rank =
    catalogResultRank(left, search) - catalogResultRank(right, search);
  if (rank !== 0) return rank;
  const name = left.name
    .toLowerCase()
    .localeCompare(right.name.toLowerCase(), "en");
  if (name !== 0) return name;
  const code = (left.code ?? "")
    .toLowerCase()
    .localeCompare((right.code ?? "").toLowerCase(), "en");
  return code || left.id.localeCompare(right.id);
}

function serializeQuote(
  lines: readonly PricedTreatmentPlanLine[],
  taxRatePercent: string,
  currency: string,
) {
  const priced = priceTreatmentPlanLines(lines, taxRatePercent);
  return {
    currency: currency.toUpperCase(),
    subtotal: centsToMoney(priced.subtotalCents),
    tax: centsToMoney(priced.taxCents),
    total: centsToMoney(priced.totalCents),
    lines: priced.lines.map((line) => ({
      sortOrder: line.sortOrder,
      description: line.description,
      offeredQuantity: line.offeredQuantity,
      unitPrice: centsToMoney(line.unitPriceCents),
      lineSubtotal: centsToMoney(line.lineSubtotalCents),
      taxAmount: centsToMoney(line.taxAmountCents),
      lineTotal: centsToMoney(line.lineTotalCents),
      itemType: line.itemType,
      serviceId: line.serviceId,
      productId: line.productId,
    })),
  };
}

async function resolveCatalogLines(
  database: TreatmentPlanDatabase,
  practiceId: string,
  items: readonly TreatmentPlanCatalogItemInput[],
): Promise<PricedTreatmentPlanLine[]> {
  const serviceIds = [
    ...new Set(
      items
        .filter((item) => item.itemType === "service")
        .map((item) => item.itemId),
    ),
  ];
  const productIds = [
    ...new Set(
      items
        .filter((item) => item.itemType === "product")
        .map((item) => item.itemId),
    ),
  ];
  const serviceRows = serviceIds.length
    ? await database
        .select({
          id: services.id,
          name: services.name,
          unitPrice: services.defaultPrice,
          taxable: services.taxable,
        })
        .from(services)
        .where(
          and(
            eq(services.practiceId, practiceId),
            inArray(services.id, serviceIds),
            isNull(services.deletedAt),
            activePracticePredicate(practiceId),
          ),
        )
    : [];
  const productRows = productIds.length
    ? await database
        .select({
          id: products.id,
          name: products.name,
          unitPrice: products.unitPrice,
          taxable: products.taxable,
        })
        .from(products)
        .where(
          and(
            eq(products.practiceId, practiceId),
            inArray(products.id, productIds),
            isNull(products.deletedAt),
            activePracticePredicate(practiceId),
          ),
        )
    : [];
  const serviceById = new Map(serviceRows.map((row) => [row.id, row]));
  const productById = new Map(productRows.map((row) => [row.id, row]));

  return items.map((item, sortOrder) => {
    const source =
      item.itemType === "service"
        ? serviceById.get(item.itemId)
        : productById.get(item.itemId);
    if (!source) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "A selected treatment-plan service or product is unavailable.",
      });
    }
    return {
      sortOrder,
      description: source.name,
      offeredQuantity: item.quantity,
      unitPriceCents: moneyToCents(source.unitPrice),
      taxable: source.taxable,
      itemType: item.itemType,
      serviceId: item.itemType === "service" ? item.itemId : null,
      productId: item.itemType === "product" ? item.itemId : null,
    };
  });
}

async function stageAndSealRevision(
  database: TreatmentPlanDatabase,
  args: {
    practiceId: string;
    planId: string;
    revisionNumber: number;
    authoredBy: string;
    operationId: string;
    payloadHash: string;
    currency: string;
    taxRatePercent: string;
    items: readonly TreatmentPlanCatalogItemInput[];
  },
): Promise<RevisionRow> {
  const priced = priceTreatmentPlanLines(
    await resolveCatalogLines(database, args.practiceId, args.items),
    args.taxRatePercent,
  );
  const revisionId = randomUUID();
  const lines = priced.lines.map((line) => ({
    id: randomUUID(),
    practiceId: args.practiceId,
    planId: args.planId,
    revisionId,
    sortOrder: line.sortOrder,
    description: line.description,
    offeredQuantity: line.offeredQuantity,
    unitPrice: centsToMoney(line.unitPriceCents),
    lineSubtotal: centsToMoney(line.lineSubtotalCents),
    taxAmount: centsToMoney(line.taxAmountCents),
    lineTotal: centsToMoney(line.lineTotalCents),
    taxable: line.taxable,
    itemType: line.itemType,
    serviceId: line.serviceId,
    productId: line.productId,
  }));
  await database.insert(visitTreatmentPlanRevisionLines).values(lines);

  const subtotal = centsToMoney(priced.subtotalCents);
  const tax = centsToMoney(priced.taxCents);
  const total = centsToMoney(priced.totalCents);
  const currency = args.currency.toUpperCase();
  const hashRows = rowsFromExecute<{ contentSha256: string }>(
    await database.execute(sql`
      select public.compute_visit_treatment_plan_revision_sha256(
        ${args.practiceId}::uuid,
        ${args.planId}::uuid,
        ${revisionId}::uuid,
        ${args.revisionNumber}::integer,
        ${currency},
        ${subtotal}::numeric,
        ${tax}::numeric,
        ${total}::numeric
      ) as "contentSha256"
    `),
  );
  const contentSha256 = hashRows[0]?.contentSha256;
  if (!contentSha256) {
    throw new Error("Treatment-plan content hash could not be computed.");
  }

  const [revision] = await database
    .insert(visitTreatmentPlanRevisions)
    .values({
      id: revisionId,
      practiceId: args.practiceId,
      planId: args.planId,
      revisionNumber: args.revisionNumber,
      currency,
      subtotal,
      tax,
      total,
      authoredBy: args.authoredBy,
      operationId: args.operationId,
      operationPayloadHash: args.payloadHash,
      contentSha256,
    })
    .returning();
  if (!revision) {
    throw new Error("Treatment-plan revision was not created.");
  }
  await database.execute(sql`set constraints all immediate`);
  return revision;
}

async function readPreview(
  database: TreatmentPlanDatabase,
  practiceId: string,
  planId: string,
  revisionNumber?: number,
) {
  const [plan] = await database
    .select({
      id: visitTreatmentPlans.id,
      clientId: visitTreatmentPlans.clientId,
      patientId: visitTreatmentPlans.patientId,
      appointmentId: visitTreatmentPlans.appointmentId,
      title: visitTreatmentPlans.title,
      status: visitTreatmentPlans.status,
      createdBy: visitTreatmentPlans.createdBy,
      createdAt: visitTreatmentPlans.createdAt,
    })
    .from(visitTreatmentPlans)
    .where(
      and(
        eq(visitTreatmentPlans.id, planId),
        eq(visitTreatmentPlans.practiceId, practiceId),
        activePracticePredicate(practiceId),
      ),
    )
    .limit(1);
  if (!plan) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Treatment plan not found",
    });
  }

  const [revision] = await database
    .select()
    .from(visitTreatmentPlanRevisions)
    .where(
      and(
        eq(visitTreatmentPlanRevisions.practiceId, practiceId),
        eq(visitTreatmentPlanRevisions.planId, planId),
        revisionNumber === undefined
          ? undefined
          : eq(visitTreatmentPlanRevisions.revisionNumber, revisionNumber),
      ),
    )
    .orderBy(desc(visitTreatmentPlanRevisions.revisionNumber))
    .limit(1);
  if (!revision) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Treatment plan revision not found",
    });
  }
  const lines = await database
    .select()
    .from(visitTreatmentPlanRevisionLines)
    .where(
      and(
        eq(visitTreatmentPlanRevisionLines.practiceId, practiceId),
        eq(visitTreatmentPlanRevisionLines.planId, planId),
        eq(visitTreatmentPlanRevisionLines.revisionId, revision.id),
      ),
    )
    .orderBy(
      asc(visitTreatmentPlanRevisionLines.sortOrder),
      asc(visitTreatmentPlanRevisionLines.id),
    );
  return { plan, revision, lines };
}

export const visitTreatmentPlansRouter = createRouter({
  getForAppointment: protectedProcedure
    .use(clinicalRole)
    .input(planContextInput)
    .query(async ({ ctx, input }) => {
      assertAuthoringEnabled();
      const [plan] = await ctx.db
        .select({ id: visitTreatmentPlans.id })
        .from(visitTreatmentPlans)
        .where(
          and(
            eq(visitTreatmentPlans.practiceId, ctx.practiceId),
            eq(visitTreatmentPlans.clientId, input.clientId),
            eq(visitTreatmentPlans.patientId, input.patientId),
            eq(visitTreatmentPlans.appointmentId, input.appointmentId),
            eq(visitTreatmentPlans.status, "open"),
            activePracticePredicate(ctx.practiceId),
          ),
        )
        .orderBy(
          desc(visitTreatmentPlans.createdAt),
          desc(visitTreatmentPlans.id),
        )
        .limit(1);
      return plan ? readPreview(ctx.db, ctx.practiceId, plan.id) : null;
    }),

  searchCatalog: protectedProcedure
    .use(clinicalRole)
    .input(
      z.object({
        search: z
          .string()
          .trim()
          .max(TEMPLATE_CATALOG_SEARCH_MAX_LENGTH)
          .default(""),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertAuthoringEnabled();
      const escapedSearch = escapeTemplateCatalogLike(input.search);
      const containsPattern = `%${escapedSearch}%`;
      const serviceRows = await ctx.db
        .select({
          id: services.id,
          name: services.name,
          code: services.code,
          category: services.category,
          unitPrice: services.defaultPrice,
        })
        .from(services)
        .where(
          and(
            eq(services.practiceId, ctx.practiceId),
            isNull(services.deletedAt),
            activePracticePredicate(ctx.practiceId),
            input.search
              ? or(
                  sql`${services.name} ilike ${containsPattern} escape '\\'`,
                  sql`${services.code} ilike ${containsPattern} escape '\\'`,
                  sql`${services.category} ilike ${containsPattern} escape '\\'`,
                )
              : undefined,
          ),
        )
        .orderBy(sql`lower(${services.name})`, asc(services.id))
        .limit(TEMPLATE_CATALOG_RESULT_LIMIT);
      const productRows = await ctx.db
        .select({
          id: products.id,
          name: products.name,
          code: products.sku,
          category: products.category,
          unitPrice: products.unitPrice,
        })
        .from(products)
        .where(
          and(
            eq(products.practiceId, ctx.practiceId),
            isNull(products.deletedAt),
            activePracticePredicate(ctx.practiceId),
            input.search
              ? or(
                  sql`${products.name} ilike ${containsPattern} escape '\\'`,
                  sql`${products.sku} ilike ${containsPattern} escape '\\'`,
                  sql`${products.category} ilike ${containsPattern} escape '\\'`,
                )
              : undefined,
          ),
        )
        .orderBy(sql`lower(${products.name})`, asc(products.id))
        .limit(TEMPLATE_CATALOG_RESULT_LIMIT);
      return [
        ...serviceRows.map((row) => ({ ...row, itemType: "service" as const })),
        ...productRows.map((row) => ({ ...row, itemType: "product" as const })),
      ]
        .sort((left, right) => compareCatalogResults(left, right, input.search))
        .slice(0, TEMPLATE_CATALOG_RESULT_LIMIT);
    }),

  quote: protectedProcedure
    .use(clinicalRole)
    .input(quotePlanInput)
    .query(async ({ ctx, input }) => {
      assertAuthoringEnabled();
      const practice = await assertCreateContext(ctx.db, ctx.practiceId, input);
      const lines = await resolveCatalogLines(
        ctx.db,
        ctx.practiceId,
        input.items,
      );
      return serializeQuote(lines, practice.taxRatePercent, practice.currency);
    }),

  preview: protectedProcedure
    .use(clinicalRole)
    .input(
      z.object({
        planId: z.string().uuid(),
        revisionNumber: z.number().int().min(1).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      assertAuthoringEnabled();
      return readPreview(
        ctx.db,
        ctx.practiceId,
        input.planId,
        input.revisionNumber,
      );
    }),

  create: protectedProcedure
    .use(clinicalRole)
    .input(createPlanInput)
    .mutation(async ({ ctx, input }) => {
      assertAuthoringEnabled();
      const canonicalItems = input.items.map((item) => ({
        ...item,
        quantity: canonicalQuantity(item.quantity),
      }));
      const payloadHash = treatmentPlanOperationHash({
        version: 1,
        action: "create",
        practiceId: ctx.practiceId,
        authoredBy: ctx.user.id,
        clientId: input.clientId,
        patientId: input.patientId,
        appointmentId: input.appointmentId ?? null,
        title: input.title,
        items: canonicalItems,
      });

      try {
        const revision = await ctx.db.transaction(async (tx) => {
          const existingPlan = await readPlanByOperation(
            tx,
            ctx.practiceId,
            input.operationId,
          );
          if (existingPlan) {
            if (existingPlan.operationPayloadHash !== payloadHash) {
              throw new TRPCError({
                code: "CONFLICT",
                message:
                  "This operation id was already used for different treatment-plan content.",
              });
            }
            const replay = exactReplay(
              await readRevisionByOperation(
                tx,
                ctx.practiceId,
                input.operationId,
              ),
              existingPlan.id,
              payloadHash,
            );
            if (!replay) {
              throw new TRPCError({
                code: "PRECONDITION_FAILED",
                message: "The existing treatment plan is incomplete.",
              });
            }
            return replay;
          }

          const practice = await assertCreateContext(tx, ctx.practiceId, input);
          const planId = randomUUID();
          const [createdPlan] = await tx
            .insert(visitTreatmentPlans)
            .values({
              id: planId,
              practiceId: ctx.practiceId,
              clientId: input.clientId,
              patientId: input.patientId,
              appointmentId: input.appointmentId,
              createdBy: ctx.user.id,
              title: input.title,
              operationId: input.operationId,
              operationPayloadHash: payloadHash,
            })
            .onConflictDoNothing({
              target: [
                visitTreatmentPlans.practiceId,
                visitTreatmentPlans.operationId,
              ],
            })
            .returning({ id: visitTreatmentPlans.id });
          if (!createdPlan) {
            const concurrentPlan = await readPlanByOperation(
              tx,
              ctx.practiceId,
              input.operationId,
            );
            if (
              !concurrentPlan ||
              concurrentPlan.operationPayloadHash !== payloadHash
            ) {
              throw new TRPCError({
                code: "CONFLICT",
                message:
                  "This operation id was already used for different treatment-plan content.",
              });
            }
            const replay = exactReplay(
              await readRevisionByOperation(
                tx,
                ctx.practiceId,
                input.operationId,
              ),
              concurrentPlan.id,
              payloadHash,
            );
            if (!replay) {
              throw new TRPCError({
                code: "CONFLICT",
                message:
                  "The treatment plan is still being created. Refresh and retry.",
              });
            }
            return replay;
          }

          return stageAndSealRevision(tx, {
            practiceId: ctx.practiceId,
            planId,
            revisionNumber: 1,
            authoredBy: ctx.user.id,
            operationId: input.operationId,
            payloadHash,
            currency: practice.currency,
            taxRatePercent: practice.taxRatePercent,
            items: canonicalItems,
          });
        });
        return readPreview(ctx.db, ctx.practiceId, revision.planId, 1);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const mapped = mapAuthoringDatabaseError(error);
        if (mapped) throw mapped;
        throw error;
      }
    }),

  revise: protectedProcedure
    .use(clinicalRole)
    .input(revisePlanInput)
    .mutation(async ({ ctx, input }) => {
      assertAuthoringEnabled();
      const canonicalItems = input.items.map((item) => ({
        ...item,
        quantity: canonicalQuantity(item.quantity),
      }));
      const payloadHash = treatmentPlanOperationHash({
        version: 1,
        action: "revise",
        practiceId: ctx.practiceId,
        authoredBy: ctx.user.id,
        planId: input.planId,
        expectedRevisionNumber: input.expectedRevisionNumber,
        items: canonicalItems,
      });

      try {
        const revision = await ctx.db.transaction(async (tx) => {
          const replayBeforeLock = exactReplay(
            await readRevisionByOperation(
              tx,
              ctx.practiceId,
              input.operationId,
            ),
            input.planId,
            payloadHash,
          );
          if (replayBeforeLock) return replayBeforeLock;

          const [plan] = await tx
            .select({ id: visitTreatmentPlans.id })
            .from(visitTreatmentPlans)
            .where(
              and(
                eq(visitTreatmentPlans.id, input.planId),
                eq(visitTreatmentPlans.practiceId, ctx.practiceId),
                eq(visitTreatmentPlans.status, "open"),
                activePracticePredicate(ctx.practiceId),
              ),
            )
            .for("update")
            .limit(1);
          if (!plan) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "This treatment plan is no longer open for revision.",
            });
          }

          const replayAfterLock = exactReplay(
            await readRevisionByOperation(
              tx,
              ctx.practiceId,
              input.operationId,
            ),
            input.planId,
            payloadHash,
          );
          if (replayAfterLock) return replayAfterLock;

          const [latest] = await tx
            .select({
              revisionNumber: visitTreatmentPlanRevisions.revisionNumber,
            })
            .from(visitTreatmentPlanRevisions)
            .where(
              and(
                eq(visitTreatmentPlanRevisions.practiceId, ctx.practiceId),
                eq(visitTreatmentPlanRevisions.planId, input.planId),
              ),
            )
            .orderBy(desc(visitTreatmentPlanRevisions.revisionNumber))
            .limit(1);
          if (
            !latest ||
            latest.revisionNumber !== input.expectedRevisionNumber
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "The treatment plan changed in another session. Refresh and retry.",
            });
          }

          const [practice] = await tx
            .select({
              currency: practices.currency,
              taxRatePercent: practices.taxRatePercent,
            })
            .from(practices)
            .where(
              and(
                eq(practices.id, ctx.practiceId),
                isNull(practices.deletedAt),
              ),
            )
            .limit(1);
          if (!practice) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Practice not found",
            });
          }

          return stageAndSealRevision(tx, {
            practiceId: ctx.practiceId,
            planId: input.planId,
            revisionNumber: input.expectedRevisionNumber + 1,
            authoredBy: ctx.user.id,
            operationId: input.operationId,
            payloadHash,
            currency: practice.currency,
            taxRatePercent: practice.taxRatePercent,
            items: canonicalItems,
          });
        });
        return readPreview(
          ctx.db,
          ctx.practiceId,
          revision.planId,
          revision.revisionNumber,
        );
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const mapped = mapAuthoringDatabaseError(error);
        if (mapped) throw mapped;
        throw error;
      }
    }),
});
