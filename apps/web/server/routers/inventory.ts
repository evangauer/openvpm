import { z } from "zod";
import { eq, and, isNull, ilike, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { practices, products, suppliers } from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { formatDateInputForTimeZone } from "@/lib/date-input";
import {
  addDaysYmd,
  inventoryAlert,
} from "@/lib/inventory/alerts";
import {
  INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH,
  INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH,
  INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH,
  INVENTORY_PRODUCT_NAME_MAX_LENGTH,
  INVENTORY_PRODUCT_SEARCH_MAX_LENGTH,
  INVENTORY_PRODUCT_SKU_MAX_LENGTH,
  INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH,
  INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH,
  INVENTORY_SUPPLIER_NAME_MAX_LENGTH,
  INVENTORY_SUPPLIER_NOTES_MAX_LENGTH,
  INVENTORY_SUPPLIER_PHONE_MAX_LENGTH,
  isInventoryCurrencyAmountInputValid,
} from "@/lib/inventory/policy";
import { clinicalDateInput } from "@/lib/records/clinical-inputs";
import { listOffsetInput } from "./pagination";
import {
  POSTGRES_INTEGER_MAX,
  integerColumnDeltaInput,
  nonnegativeIntegerColumnInput,
} from "./storage-bounds";

const inventoryAlertFilterSchema = z
  .enum(["all", "attention", "low_stock", "expired", "expiring_soon"])
  .default("all");

const moneyInput = z
  .string()
  .trim()
  .refine(
    isInventoryCurrencyAmountInputValid,
    "Amount must be a valid currency amount."
  );

const requiredTrimmedString = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} must be at most ${max} characters.`);

const optionalTrimmedString = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .optional();

const optionalEmailInput = z
  .string()
  .trim()
  .email()
  .max(INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH)
  .transform((value) => value.toLowerCase())
  .optional();

const nullableOptionalEmailInput = z
  .union([
    z
      .string()
      .trim()
      .email()
      .max(INVENTORY_SUPPLIER_EMAIL_MAX_LENGTH)
      .transform((value) => value.toLowerCase()),
    z.null(),
  ])
  .optional();

const nullableOptionalTrimmedString = (label: string, max: number) =>
  z
    .union([
      z
        .string()
        .trim()
        .max(max, `${label} must be at most ${max} characters.`),
      z.null(),
    ])
    .optional();

const productCreateInput = z.object({
  name: requiredTrimmedString(
    "Product name",
    INVENTORY_PRODUCT_NAME_MAX_LENGTH
  ),
  sku: optionalTrimmedString("SKU", INVENTORY_PRODUCT_SKU_MAX_LENGTH),
  category: optionalTrimmedString(
    "Category",
    INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH
  ),
  unitPrice: moneyInput,
  taxable: z.boolean().default(true),
  costPrice: moneyInput.optional(),
  stockQuantity: nonnegativeIntegerColumnInput.default(0),
  reorderPoint: nonnegativeIntegerColumnInput.default(10),
  lotNumber: optionalTrimmedString(
    "Lot number",
    INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH
  ),
  expirationDate: clinicalDateInput("Expiration date").optional(),
});

const productUpdateInput = z
  .object({
    id: z.string().uuid(),
    name: requiredTrimmedString(
      "Product name",
      INVENTORY_PRODUCT_NAME_MAX_LENGTH
    ).optional(),
    sku: optionalTrimmedString("SKU", INVENTORY_PRODUCT_SKU_MAX_LENGTH),
    category: optionalTrimmedString(
      "Category",
      INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH
    ),
    unitPrice: moneyInput.optional(),
    taxable: z.boolean().optional(),
    costPrice: moneyInput.optional(),
    reorderPoint: nonnegativeIntegerColumnInput.optional(),
    lotNumber: optionalTrimmedString(
      "Lot number",
      INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH
    ),
    expirationDate: clinicalDateInput("Expiration date").nullable().optional(),
  })
  .strict();

type InventoryContext = {
  db: Pick<Database, "select">;
  practiceId: string;
};

const inventoryManagerProcedure = protectedProcedure.use(
  requireRole("admin", "veterinarian", "technician", "front_desk")
);

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

async function assertActivePractice(ctx: InventoryContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);

  if (!practice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  }
}

async function practiceTimeZone(
  ctx: InventoryContext
): Promise<string | null> {
  const [practice] = await ctx.db
    .select({ timezone: practices.timezone })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);
  if (!practice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  }
  return practice.timezone ?? null;
}

export const inventoryRouter = createRouter({
  // --- Products ---

  list: protectedProcedure
    .input(
      z.object({
        search: optionalTrimmedString(
          "Search",
          INVENTORY_PRODUCT_SEARCH_MAX_LENGTH
        ),
        category: optionalTrimmedString(
          "Category",
          INVENTORY_PRODUCT_CATEGORY_MAX_LENGTH
        ),
        alert: inventoryAlertFilterSchema.optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: listOffsetInput,
      })
    )
    .query(async ({ ctx, input }) => {
      const todayYmd = formatDateInputForTimeZone(
        new Date(),
        await practiceTimeZone(ctx)
      );
      const soonYmd = addDaysYmd(todayYmd, 90);
      const lowStockCondition = sql`${products.inventoryTracked} and ${products.stockQuantity} <= coalesce(${products.reorderPoint}, 10)`;
      const expiredCondition = sql`${products.inventoryTracked} and ${products.expirationDate} is not null and ${products.expirationDate} < ${todayYmd}`;
      const expiringSoonCondition = sql`${products.inventoryTracked} and ${products.expirationDate} is not null and ${products.expirationDate} >= ${todayYmd} and ${products.expirationDate} <= ${soonYmd}`;
      const attentionCondition = sql`(${lowStockCondition} or (${products.inventoryTracked} and ${products.expirationDate} is not null and ${products.expirationDate} <= ${soonYmd}))`;

      const baseConditions: SQL[] = [
        eq(products.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(products.deletedAt),
      ];

      if (input.search) {
        baseConditions.push(
          sql`(${ilike(products.name, `%${input.search}%`)} OR ${ilike(products.sku, `%${input.search}%`)})`
        );
      }

      if (input.category) {
        baseConditions.push(eq(products.category, input.category));
      }

      const alertCondition =
        input.alert === "attention"
          ? attentionCondition
          : input.alert === "low_stock"
            ? lowStockCondition
            : input.alert === "expired"
              ? expiredCondition
              : input.alert === "expiring_soon"
                ? expiringSoonCondition
                : null;
      const conditions = alertCondition
        ? [...baseConditions, alertCondition]
        : baseConditions;

      const countWhere = (extra?: SQL) =>
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(products)
          .where(and(...(extra ? [...baseConditions, extra] : baseConditions)));

      const [
        items,
        countResult,
        attentionCount,
        lowStockCount,
        expiredCount,
        expiringSoonCount,
      ] = await Promise.all([
        ctx.db
          .select()
          .from(products)
          .where(and(...conditions))
          .orderBy(products.name, products.id)
          .limit(input.limit)
          .offset(input.offset),
        countWhere(alertCondition ?? undefined),
        countWhere(attentionCondition),
        countWhere(lowStockCondition),
        countWhere(expiredCondition),
        countWhere(expiringSoonCondition),
      ]);

      return {
        items: items.map((p) => ({
          ...p,
          ...inventoryAlert(p, todayYmd),
        })),
        total: Number(countResult[0]?.count ?? 0),
        alertCounts: {
          attention: Number(attentionCount[0]?.count ?? 0),
          lowStock: Number(lowStockCount[0]?.count ?? 0),
          expired: Number(expiredCount[0]?.count ?? 0),
          expiringSoon: Number(expiringSoonCount[0]?.count ?? 0),
        },
      };
    }),

  create: inventoryManagerProcedure
    .input(productCreateInput)
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [product] = await ctx.db
        .insert(products)
        .values({
          practiceId: ctx.practiceId,
          name: input.name,
          sku: input.sku ?? null,
          category: input.category ?? null,
          unitPrice: input.unitPrice,
          taxable: input.taxable,
          costPrice: input.costPrice ?? null,
          inventoryTracked: true,
          stockQuantity: input.stockQuantity,
          reorderPoint: input.reorderPoint,
          lotNumber: input.lotNumber ?? null,
          expirationDate: input.expirationDate ?? null,
        })
        .returning();
      return product!;
    }),

  update: inventoryManagerProcedure
    .input(productUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const { id, ...updates } = input;
      // Filter out undefined values
      const setValues: Record<string, unknown> = {};
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

      const [product] = await ctx.db
        .update(products)
        .set(setValues)
        .where(
          and(
            eq(products.id, id),
            eq(products.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(products.deletedAt)
          )
        )
        .returning();

      if (!product) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Product not found",
        });
      }
      return product;
    }),

  startTracking: inventoryManagerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        stockQuantity: nonnegativeIntegerColumnInput,
        reorderPoint: nonnegativeIntegerColumnInput.default(10),
        lotNumber: optionalTrimmedString(
          "Lot number",
          INVENTORY_PRODUCT_LOT_NUMBER_MAX_LENGTH
        ),
        expirationDate: clinicalDateInput("Expiration date").optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [product] = await ctx.db
        .update(products)
        .set({
          inventoryTracked: true,
          stockQuantity: input.stockQuantity,
          reorderPoint: input.reorderPoint,
          lotNumber: input.lotNumber ?? null,
          expirationDate: input.expirationDate ?? null,
        })
        .where(
          and(
            eq(products.id, input.id),
            eq(products.practiceId, ctx.practiceId),
            eq(products.inventoryTracked, false),
            activePracticePredicate(ctx.practiceId),
            isNull(products.deletedAt)
          )
        )
        .returning();
      if (!product) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This product is unavailable or stock tracking has already started. Refresh and try again.",
        });
      }
      return product;
    }),

  adjustStock: inventoryManagerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        adjustment: integerColumnDeltaInput,
        reason: requiredTrimmedString(
          "Reason",
          INVENTORY_ADJUSTMENT_REASON_MAX_LENGTH
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [current] = await ctx.db
        .select({
          id: products.id,
          inventoryTracked: products.inventoryTracked,
          stockQuantity: products.stockQuantity,
        })
        .from(products)
        .where(
          and(
            eq(products.id, input.id),
            eq(products.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(products.deletedAt)
          )
        )
        .limit(1);

      if (!current) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Product not found",
        });
      }

      if (current.inventoryTracked === false) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Start stock tracking with a reviewed opening quantity before recording adjustments.",
        });
      }

      if (current.stockQuantity + input.adjustment < 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Stock adjustment would make quantity negative.",
        });
      }
      if (current.stockQuantity + input.adjustment > POSTGRES_INTEGER_MAX) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Stock adjustment would exceed the maximum stock quantity.",
        });
      }

      const [product] = await ctx.db
        .update(products)
        .set({
          stockQuantity: sql`${products.stockQuantity} + ${input.adjustment}`,
        })
        .where(
          and(
            eq(products.id, input.id),
            eq(products.practiceId, ctx.practiceId),
            eq(products.inventoryTracked, true),
            activePracticePredicate(ctx.practiceId),
            isNull(products.deletedAt),
            sql`${products.stockQuantity} + ${input.adjustment} >= 0`,
            sql`${products.stockQuantity} + ${input.adjustment} <= ${POSTGRES_INTEGER_MAX}`
          )
        )
        .returning();

      if (!product) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Stock adjustment would move quantity outside the allowed stock range.",
        });
      }
      return product;
    }),

  // --- Suppliers ---

  listSuppliers: protectedProcedure.query(async ({ ctx }) => {
    await assertActivePractice(ctx);
    return ctx.db
      .select()
      .from(suppliers)
      .where(
        and(
          eq(suppliers.practiceId, ctx.practiceId),
          activePracticePredicate(ctx.practiceId),
          isNull(suppliers.deletedAt)
        )
      )
      .orderBy(suppliers.name);
  }),

  createSupplier: inventoryManagerProcedure
    .input(
      z.object({
        name: requiredTrimmedString(
          "Supplier name",
          INVENTORY_SUPPLIER_NAME_MAX_LENGTH
        ),
        contactEmail: optionalEmailInput,
        phone: optionalTrimmedString(
          "Phone",
          INVENTORY_SUPPLIER_PHONE_MAX_LENGTH
        ),
        address: optionalTrimmedString(
          "Address",
          INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH
        ),
        notes: optionalTrimmedString(
          "Notes",
          INVENTORY_SUPPLIER_NOTES_MAX_LENGTH
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const [supplier] = await ctx.db
        .insert(suppliers)
        .values({
          practiceId: ctx.practiceId,
          name: input.name,
          contactEmail: input.contactEmail ?? null,
          phone: input.phone ?? null,
          address: input.address ?? null,
          notes: input.notes ?? null,
        })
        .returning();
      return supplier!;
    }),

  updateSupplier: inventoryManagerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: requiredTrimmedString(
          "Supplier name",
          INVENTORY_SUPPLIER_NAME_MAX_LENGTH
        ).optional(),
        contactEmail: nullableOptionalEmailInput,
        phone: nullableOptionalTrimmedString(
          "Phone",
          INVENTORY_SUPPLIER_PHONE_MAX_LENGTH
        ),
        address: nullableOptionalTrimmedString(
          "Address",
          INVENTORY_SUPPLIER_ADDRESS_MAX_LENGTH
        ),
        notes: nullableOptionalTrimmedString(
          "Notes",
          INVENTORY_SUPPLIER_NOTES_MAX_LENGTH
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...updates } = input;
      const setValues: Record<string, unknown> = {};
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

      const [supplier] = await ctx.db
        .update(suppliers)
        .set(setValues)
        .where(
          and(
            eq(suppliers.id, id),
            eq(suppliers.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(suppliers.deletedAt)
          )
        )
        .returning();

      if (!supplier) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Supplier not found",
        });
      }

      return supplier;
    }),
});
