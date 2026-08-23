import { z } from "zod";
import { eq, and, isNull, asc, inArray, sql, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  treatmentTemplates,
  treatmentTemplateItems,
  invoices,
  invoiceItems,
  practices,
  products,
  services,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  clinicalTextInput,
  optionalClinicalTextInput,
} from "@/lib/records/clinical-inputs";
import { centsToMoney, moneyToCents } from "@/lib/billing/invoice-balance";
import {
  calculateInvoiceTaxTotals,
  InvoiceTaxCalculationError,
} from "@/lib/billing/invoice-tax";
import { computeStockDeductions } from "@/lib/inventory/dispense";
import {
  TREATMENT_TEMPLATE_CATEGORY_MAX_LENGTH,
  TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH,
  TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH,
  TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX,
  TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN,
  TREATMENT_TEMPLATE_ITEM_SORT_ORDER_MAX,
  TREATMENT_TEMPLATE_ITEM_SORT_ORDER_MIN,
  TREATMENT_TEMPLATE_MAX_ITEMS,
  TREATMENT_TEMPLATE_MAX_MONEY_CENTS,
  TREATMENT_TEMPLATE_NAME_MAX_LENGTH,
  TREATMENT_TEMPLATE_UNIT_PRICE_PATTERN,
} from "@/lib/templates/policy";
import {
  escapeTemplateCatalogLike,
  hasDuplicateTemplateCatalogItems,
  TEMPLATE_CATALOG_RESULT_LIMIT,
  TEMPLATE_CATALOG_SEARCH_MAX_LENGTH,
} from "@/lib/templates/catalog-search";

type TemplatesDb = Pick<Database, "select" | "update">;

type TemplatesContext = {
  db: TemplatesDb;
  practiceId: string;
};

type TemplateInvoiceItem = {
  itemType: "service" | "product";
  itemId?: string | null;
  quantity: number;
};

const moneyInput = z
  .string()
  .trim()
  .refine((value) => {
    return TREATMENT_TEMPLATE_UNIT_PRICE_PATTERN.test(value);
  }, "Amount must be a valid currency amount.");

const PRODUCT_LINK_REQUIRED_MESSAGE =
  "Every product template item must be linked to an active inventory product.";

const templateItemBaseInput = z.object({
  itemType: z.enum(["service", "product"]),
  itemId: z.string().uuid().optional(),
  description: clinicalTextInput(
    "Template item description",
    TREATMENT_TEMPLATE_ITEM_DESCRIPTION_MAX_LENGTH,
  ),
  defaultQuantity: z
    .number()
    .int()
    .min(TREATMENT_TEMPLATE_ITEM_QUANTITY_MIN)
    .max(TREATMENT_TEMPLATE_ITEM_QUANTITY_MAX)
    .default(1),
  defaultUnitPrice: moneyInput,
  sortOrder: z
    .number()
    .int()
    .min(TREATMENT_TEMPLATE_ITEM_SORT_ORDER_MIN)
    .max(TREATMENT_TEMPLATE_ITEM_SORT_ORDER_MAX)
    .default(0),
});

function refineTemplateItemTotal(
  item: z.infer<typeof templateItemBaseInput>,
  ctx: z.RefinementCtx,
) {
  if (item.itemType === "product" && !item.itemId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["itemId"],
      message: PRODUCT_LINK_REQUIRED_MESSAGE,
    });
  }

  const totalCents = moneyToCents(item.defaultUnitPrice) * item.defaultQuantity;
  if (totalCents > TREATMENT_TEMPLATE_MAX_MONEY_CENTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultUnitPrice"],
      message: "Template item total must fit a currency amount.",
    });
  }
}

const templateItemInput = templateItemBaseInput.superRefine(
  refineTemplateItemTotal,
);

const addTemplateItemInput = templateItemBaseInput
  .extend({ templateId: z.string().uuid() })
  .superRefine(refineTemplateItemTotal);

const templateMutableInput = {
  name: clinicalTextInput("Template name", TREATMENT_TEMPLATE_NAME_MAX_LENGTH),
  description: optionalClinicalTextInput(
    "Template description",
    TREATMENT_TEMPLATE_DESCRIPTION_MAX_LENGTH,
  ),
  category: optionalClinicalTextInput(
    "Template category",
    TREATMENT_TEMPLATE_CATEGORY_MAX_LENGTH,
  ),
};

const createTemplateInput = z
  .object({
    ...templateMutableInput,
    items: z
      .array(templateItemInput)
      .max(
        TREATMENT_TEMPLATE_MAX_ITEMS,
        `Templates can include at most ${TREATMENT_TEMPLATE_MAX_ITEMS} items.`,
      ),
  })
  .superRefine((input, ctx) => {
    if (hasDuplicateTemplateCatalogItems(input.items)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["items"],
        message: "A service or product can only appear once in a template.",
      });
    }
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

async function assertActivePractice(ctx: TemplatesContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(activePracticeWhere(ctx.practiceId))
    .limit(1);

  if (!practice) {
    throw practiceNotFound();
  }
}

async function lockActiveTemplateCatalogItems(
  ctx: TemplatesContext,
  items: Array<{ itemType: "service" | "product"; itemId?: string }>,
  options: { lockProductsForStock?: boolean } = {},
) {
  if (items.some((item) => item.itemType === "product" && !item.itemId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: PRODUCT_LINK_REQUIRED_MESSAGE,
    });
  }

  const serviceIds = [
    ...new Set(
      items
        .filter((item) => item.itemType === "service" && item.itemId)
        .map((item) => item.itemId!),
    ),
  ];
  const productIds = [
    ...new Set(
      items
        .filter((item) => item.itemType === "product" && item.itemId)
        .map((item) => item.itemId!),
    ),
  ];

  // Keep lock acquisition deterministic: services first, then products, with
  // rows ordered by ID inside each table. Catalog locks prevent a row from
  // being archived between validation and invoice-item insertion. Real
  // invoices take product update locks because stock changes in this write.
  const lockedServices =
    serviceIds.length === 0
      ? []
      : await ctx.db
          .select({ id: services.id, taxable: services.taxable })
          .from(services)
          .where(
            and(
              inArray(services.id, serviceIds),
              eq(services.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(services.deletedAt),
            ),
          )
          .orderBy(asc(services.id))
          .for("share");

  if (lockedServices.length !== serviceIds.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
  }

  const lockedProducts =
    productIds.length === 0
      ? []
      : await ctx.db
          .select({ id: products.id, taxable: products.taxable })
          .from(products)
          .where(
            and(
              inArray(products.id, productIds),
              eq(products.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(products.deletedAt),
            ),
          )
          .orderBy(asc(products.id))
          .for(options.lockProductsForStock ? "update" : "share");

  if (lockedProducts.length !== productIds.length) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Product not found" });
  }

  return new Map<string, boolean>([
    ...lockedServices.map(
      (row) => [`service:${row.id}`, row.taxable ?? true] as const,
    ),
    ...lockedProducts.map(
      (row) => [`product:${row.id}`, row.taxable ?? true] as const,
    ),
  ]);
}

function templateItemTaxable(
  item: Pick<TemplateInvoiceItem, "itemType" | "itemId">,
  taxabilityByReference: ReadonlyMap<string, boolean>,
): boolean {
  if (!item.itemId) return true;
  const taxable = taxabilityByReference.get(`${item.itemType}:${item.itemId}`);
  if (taxable === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Template catalog item not found",
    });
  }
  return taxable;
}

function templateInvoiceTaxTotals(
  items: readonly {
    quantity: number;
    unitPrice: string;
    taxable: boolean;
  }[],
  taxRatePercent: string,
) {
  try {
    return calculateInvoiceTaxTotals(
      items.map((row) => ({
        lineTotalCents: row.quantity * moneyToCents(row.unitPrice),
        taxable: row.taxable,
      })),
      taxRatePercent,
    );
  } catch (error) {
    if (error instanceof InvoiceTaxCalculationError) {
      throw new TRPCError({
        code:
          error.reason === "invalid_tax_rate"
            ? "PRECONDITION_FAILED"
            : "BAD_REQUEST",
        message: error.message,
      });
    }
    throw error;
  }
}

async function deductTemplateProductStock(
  ctx: TemplatesContext,
  items: readonly TemplateInvoiceItem[],
) {
  const deductions = computeStockDeductions([...items]);
  const trackedRows =
    deductions.length === 0
      ? []
      : await ctx.db
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              inArray(
                products.id,
                deductions.map((deduction) => deduction.productId),
              ),
              eq(products.practiceId, ctx.practiceId),
              eq(products.inventoryTracked, true),
              isNull(products.deletedAt),
            ),
          );
  const trackedIds = new Set(trackedRows.map((row) => row.id));
  for (const deduction of deductions) {
    if (!trackedIds.has(deduction.productId)) continue;
    const [product] = await ctx.db
      .update(products)
      .set({
        stockQuantity: sql`${products.stockQuantity} - ${deduction.quantity}`,
      })
      .where(
        and(
          eq(products.id, deduction.productId),
          eq(products.practiceId, ctx.practiceId),
          eq(products.inventoryTracked, true),
          activePracticePredicate(ctx.practiceId),
          isNull(products.deletedAt),
          sql`${products.stockQuantity} >= ${deduction.quantity}`,
        ),
      )
      .returning({ id: products.id, stockQuantity: products.stockQuantity });

    if (!product) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Insufficient stock for one or more product template items.",
      });
    }
  }
}

export const templatesRouter = createRouter({
  list: protectedProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return ctx.db
      .select()
      .from(treatmentTemplates)
      .where(
        and(
          eq(treatmentTemplates.practiceId, ctx.practiceId),
          isNull(treatmentTemplates.deletedAt),
        ),
      )
      .orderBy(asc(treatmentTemplates.name));
  }),

  searchCatalog: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        itemType: z.enum(["service", "product"]),
        search: z
          .string()
          .trim()
          .max(TEMPLATE_CATALOG_SEARCH_MAX_LENGTH)
          .default(""),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const escapedSearch = escapeTemplateCatalogLike(input.search);
      const containsPattern = `%${escapedSearch}%`;
      const prefixPattern = `${escapedSearch}%`;

      if (input.itemType === "service") {
        const rows = await ctx.db
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
              activePracticePredicate(ctx.practiceId),
              isNull(services.deletedAt),
              input.search
                ? or(
                    sql`${services.name} ilike ${containsPattern} escape '\\'`,
                    sql`${services.code} ilike ${containsPattern} escape '\\'`,
                    sql`${services.category} ilike ${containsPattern} escape '\\'`,
                  )
                : undefined,
            ),
          )
          .orderBy(
            ...(input.search
              ? [
                  sql`case
                  when lower(${services.name}) = lower(${input.search}) then 0
                  when lower(${services.code}) = lower(${input.search}) then 1
                  when ${services.name} ilike ${prefixPattern} escape '\\' then 2
                  when ${services.code} ilike ${prefixPattern} escape '\\' then 3
                  else 4
                end`,
                ]
              : []),
            sql`lower(${services.name})`,
            sql`lower(coalesce(${services.code}, ''))`,
            asc(services.id),
          )
          .limit(TEMPLATE_CATALOG_RESULT_LIMIT);
        return rows.map((row) => ({
          ...row,
          itemType: "service" as const,
        }));
      }

      const rows = await ctx.db
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
            activePracticePredicate(ctx.practiceId),
            isNull(products.deletedAt),
            input.search
              ? or(
                  sql`${products.name} ilike ${containsPattern} escape '\\'`,
                  sql`${products.sku} ilike ${containsPattern} escape '\\'`,
                  sql`${products.category} ilike ${containsPattern} escape '\\'`,
                )
              : undefined,
          ),
        )
        .orderBy(
          ...(input.search
            ? [
                sql`case
                when lower(${products.name}) = lower(${input.search}) then 0
                when lower(${products.sku}) = lower(${input.search}) then 1
                when ${products.name} ilike ${prefixPattern} escape '\\' then 2
                when ${products.sku} ilike ${prefixPattern} escape '\\' then 3
                else 4
              end`,
              ]
            : []),
          sql`lower(${products.name})`,
          sql`lower(coalesce(${products.sku}, ''))`,
          asc(products.id),
        )
        .limit(TEMPLATE_CATALOG_RESULT_LIMIT);
      return rows.map((row) => ({ ...row, itemType: "product" as const }));
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [template] = await ctx.db
        .select()
        .from(treatmentTemplates)
        .where(
          and(
            eq(treatmentTemplates.id, input.id),
            eq(treatmentTemplates.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentTemplates.deletedAt),
          ),
        )
        .limit(1);

      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Treatment template not found",
        });
      }

      const items = await ctx.db
        .select()
        .from(treatmentTemplateItems)
        .where(
          and(
            eq(treatmentTemplateItems.templateId, input.id),
            isNull(treatmentTemplateItems.deletedAt),
          ),
        )
        .orderBy(asc(treatmentTemplateItems.sortOrder));

      const linkedProductIds = [
        ...new Set(
          items
            .filter((item) => item.itemType === "product" && item.itemId)
            .map((item) => item.itemId!),
        ),
      ];
      const activeLinkedProducts =
        linkedProductIds.length === 0
          ? []
          : await ctx.db
              .select({ id: products.id })
              .from(products)
              .where(
                and(
                  inArray(products.id, linkedProductIds),
                  eq(products.practiceId, ctx.practiceId),
                  activePracticePredicate(ctx.practiceId),
                  isNull(products.deletedAt),
                ),
              );
      const activeLinkedProductIds = new Set(
        activeLinkedProducts.map((product) => product.id),
      );

      return {
        ...template,
        items: items.map((item) => ({
          ...item,
          hasActiveProductLink:
            item.itemType === "product"
              ? Boolean(item.itemId && activeLinkedProductIds.has(item.itemId))
              : null,
        })),
      };
    }),

  create: protectedProcedure
    .use(requireRole("admin"))
    .input(createTemplateInput)
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);

      return ctx.db.transaction(async (tx) => {
        // Keep catalog validation and insertion in the same transaction. The
        // share locks prevent an item from being archived after validation but
        // before the template persists its reference.
        await lockActiveTemplateCatalogItems(
          { db: tx, practiceId: ctx.practiceId },
          input.items,
        );

        const [template] = await tx
          .insert(treatmentTemplates)
          .values({
            practiceId: ctx.practiceId,
            name: input.name,
            description: input.description ?? null,
            category: input.category ?? null,
          })
          .returning();

        if (input.items.length > 0) {
          await tx.insert(treatmentTemplateItems).values(
            input.items.map((item) => ({
              templateId: template!.id,
              itemType: item.itemType as "service" | "product",
              itemId: item.itemId ?? null,
              description: item.description,
              defaultQuantity: item.defaultQuantity,
              defaultUnitPrice: item.defaultUnitPrice,
              sortOrder: item.sortOrder,
            })),
          );
        }

        return template!;
      });
    }),

  update: protectedProcedure
    .use(requireRole("admin"))
    .input(
      z.object({
        id: z.string().uuid(),
        name: templateMutableInput.name.optional(),
        description: templateMutableInput.description,
        category: templateMutableInput.category,
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const { id, ...updates } = input;
      const [template] = await ctx.db
        .update(treatmentTemplates)
        .set(updates)
        .where(
          and(
            eq(treatmentTemplates.id, id),
            eq(treatmentTemplates.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentTemplates.deletedAt),
          ),
        )
        .returning();

      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Treatment template not found",
        });
      }

      return template;
    }),

  delete: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [template] = await ctx.db
        .update(treatmentTemplates)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(treatmentTemplates.id, input.id),
            eq(treatmentTemplates.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentTemplates.deletedAt),
          ),
        )
        .returning();

      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Treatment template not found",
        });
      }

      return template;
    }),

  addItem: protectedProcedure
    .use(requireRole("admin"))
    .input(addTemplateItemInput)
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);

      return ctx.db.transaction(async (tx) => {
        // Verify the template belongs to this practice inside the same
        // transaction that locks the catalog reference and inserts the row.
        const [template] = await tx
          .select({ id: treatmentTemplates.id })
          .from(treatmentTemplates)
          .where(
            and(
              eq(treatmentTemplates.id, input.templateId),
              eq(treatmentTemplates.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(treatmentTemplates.deletedAt),
            ),
          )
          .limit(1);

        if (!template) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Treatment template not found",
          });
        }

        await lockActiveTemplateCatalogItems(
          { db: tx, practiceId: ctx.practiceId },
          [input],
        );

        const [item] = await tx
          .insert(treatmentTemplateItems)
          .values({
            templateId: input.templateId,
            itemType: input.itemType as "service" | "product",
            itemId: input.itemId ?? null,
            description: input.description,
            defaultQuantity: input.defaultQuantity,
            defaultUnitPrice: input.defaultUnitPrice,
            sortOrder: input.sortOrder,
          })
          .returning();

        return item!;
      });
    }),

  removeItem: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      // Verify item belongs to a template owned by this practice
      const itemRows = await ctx.db
        .select({
          itemId: treatmentTemplateItems.id,
          practiceId: treatmentTemplates.practiceId,
        })
        .from(treatmentTemplateItems)
        .innerJoin(
          treatmentTemplates,
          eq(treatmentTemplateItems.templateId, treatmentTemplates.id),
        )
        .where(
          and(
            eq(treatmentTemplateItems.id, input.id),
            eq(treatmentTemplates.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentTemplates.deletedAt),
            isNull(treatmentTemplateItems.deletedAt),
          ),
        )
        .limit(1);

      if (!itemRows.length || itemRows[0]!.practiceId !== ctx.practiceId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template item not found",
        });
      }

      const [removed] = await ctx.db
        .update(treatmentTemplateItems)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(treatmentTemplateItems.id, input.id),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentTemplateItems.deletedAt),
          ),
        )
        .returning();

      if (!removed) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template item not found",
        });
      }

      return removed;
    }),

  applyToInvoice: protectedProcedure
    .use(requireRole("admin", "veterinarian", "front_desk"))
    .input(
      z.object({
        templateId: z.string().uuid(),
        invoiceId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      // Verify template belongs to this practice
      const [template] = await ctx.db
        .select({ id: treatmentTemplates.id })
        .from(treatmentTemplates)
        .where(
          and(
            eq(treatmentTemplates.id, input.templateId),
            eq(treatmentTemplates.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(treatmentTemplates.deletedAt),
            eq(treatmentTemplates.isActive, true),
          ),
        )
        .limit(1);

      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Treatment template not found",
        });
      }

      // Verify invoice belongs to this practice
      const [invoice] = await ctx.db
        .select({
          id: invoices.id,
          status: invoices.status,
          paidAmount: invoices.paidAmount,
          isEstimate: invoices.isEstimate,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, input.invoiceId),
            eq(invoices.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(invoices.deletedAt),
          ),
        )
        .limit(1);

      if (!invoice) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invoice not found",
        });
      }
      if (invoice.status !== "draft") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Apply treatment templates before sending the invoice.",
        });
      }
      if (moneyToCents(invoice.paidAmount) > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Cannot apply treatment templates to invoices with payments.",
        });
      }

      return ctx.db.transaction(async (tx) => {
        // Share the invoice serialization key used by direct charge edits so
        // concurrent template applications cannot calculate competing totals.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${input.invoiceId}, 0))`,
        );

        // Fetch template items
        const items = await tx
          .select()
          .from(treatmentTemplateItems)
          .where(
            and(
              eq(treatmentTemplateItems.templateId, input.templateId),
              isNull(treatmentTemplateItems.deletedAt),
            ),
          )
          .orderBy(asc(treatmentTemplateItems.sortOrder));

        if (items.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Template has no items",
          });
        }

        // Templates snapshot descriptions and prices, but active catalog
        // references still need to be valid when the template is used. This
        // prevents archived services or products from silently being charged
        // on new invoices.
        const taxabilityByReference = await lockActiveTemplateCatalogItems(
          { db: tx, practiceId: ctx.practiceId },
          items.map((item) => ({
            itemType: item.itemType,
            itemId: item.itemId ?? undefined,
          })),
          { lockProductsForStock: !invoice.isEstimate },
        );

        const invoiceItemRows = items.map((item) => {
          const totalCents =
            item.defaultQuantity * moneyToCents(item.defaultUnitPrice);
          if (totalCents > TREATMENT_TEMPLATE_MAX_MONEY_CENTS) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Template item total must fit a currency amount.",
            });
          }
          return {
            invoiceId: input.invoiceId,
            description: item.description,
            quantity: item.defaultQuantity,
            unitPrice: item.defaultUnitPrice,
            total: centsToMoney(totalCents),
            itemType: item.itemType,
            itemId: item.itemId,
            taxable: templateItemTaxable(item, taxabilityByReference),
          };
        });

        if (!invoice.isEstimate) {
          await deductTemplateProductStock(
            { db: tx, practiceId: ctx.practiceId },
            invoiceItemRows,
          );
        }

        // Insert template items as invoice items
        await tx.insert(invoiceItems).values(invoiceItemRows);

        // Recalculate invoice totals (fetch ALL items for this invoice)
        const allItems = await tx
          .select({
            quantity: invoiceItems.quantity,
            unitPrice: invoiceItems.unitPrice,
            taxable: invoiceItems.taxable,
          })
          .from(invoiceItems)
          .where(
            and(
              eq(invoiceItems.invoiceId, input.invoiceId),
              isNull(invoiceItems.deletedAt),
            ),
          );

        // Tax rate is configured per practice (region-aware), not hardcoded.
        const [practice] = await tx
          .select({ taxRatePercent: practices.taxRatePercent })
          .from(practices)
          .where(activePracticeWhere(ctx.practiceId))
          .limit(1);
        if (!practice) {
          throw practiceNotFound();
        }
        const totals = templateInvoiceTaxTotals(
          allItems.map((row) => ({ ...row, taxable: row.taxable ?? true })),
          practice.taxRatePercent ?? "8.00",
        );

        if (
          totals.subtotalCents > TREATMENT_TEMPLATE_MAX_MONEY_CENTS ||
          totals.taxCents > TREATMENT_TEMPLATE_MAX_MONEY_CENTS ||
          totals.totalCents > TREATMENT_TEMPLATE_MAX_MONEY_CENTS
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invoice totals must fit a currency amount.",
          });
        }

        const [updatedInvoice] = await tx
          .update(invoices)
          .set({
            subtotal: centsToMoney(totals.subtotalCents),
            tax: centsToMoney(totals.taxCents),
            total: centsToMoney(totals.totalCents),
          })
          .where(
            and(
              eq(invoices.id, input.invoiceId),
              eq(invoices.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              eq(invoices.status, invoice.status),
              eq(invoices.paidAmount, invoice.paidAmount ?? "0"),
              eq(invoices.isEstimate, invoice.isEstimate),
              isNull(invoices.deletedAt),
            ),
          )
          .returning();

        if (!updatedInvoice) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Invoice changed while applying the template. Refresh and try again.",
          });
        }

        return updatedInvoice;
      });
    }),
});
