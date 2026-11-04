import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { controlledSubstancesRouter } from "../routers/controlled-substances";
import { inventoryRouter } from "../routers/inventory";
import { createRouter } from "../trpc";

const router = createRouter({
  controlledSubstances: controlledSubstancesRouter,
  inventory: inventoryRouter,
});

const integration =
  process.env.DUPLICATE_SUBMIT_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;

integration("Duplicate submit PostgreSQL contract", () => {
  it("writes one controlled-substance entry and one stock movement per submission", async () => {
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    const databaseName = `openpims_duplicate_submit_${randomUUID().replaceAll("-", "")}`;
    if (!/^openpims_duplicate_submit_[a-f0-9]+$/.test(databaseName))
      throw new Error("unsafe database name");
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    databaseUrl.search = "";
    databaseUrl.hash = "";
    const admin = postgres(adminUrl, { max: 1 });
    let owner: ReturnType<typeof postgres> | undefined;
    let app: ReturnType<typeof postgres> | undefined;
    await admin.unsafe(`create database "${databaseName}"`);
    try {
      for (const command of ["db:migrate", "db:rls"]) {
        execFileSync("pnpm", ["--filter", "@openpims/db", command], {
          cwd: resolve(process.cwd(), "../.."),
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          stdio: "pipe",
          timeout: 45_000,
        });
      }
      owner = postgres(databaseUrl.toString(), { max: 1 });
      const ownerDb = drizzle(owner, { schema });
      // Several pooled connections so double submits really run concurrently,
      // each as the least-privilege application role under RLS.
      app = postgres(databaseUrl.toString(), {
        max: 4,
        connection: { role: "openpims_app" },
      });
      const appDb = drizzle(app, { schema });

      const [a, b] = await ownerDb
        .insert(schema.practices)
        .values([{ name: "Synthetic Clinic A" }, { name: "Synthetic Clinic B" }])
        .returning();
      const [vet, otherVet] = await ownerDb
        .insert(schema.users)
        .values([
          {
            practiceId: a!.id,
            name: "Synthetic Doctor",
            email: "dup-a@example.invalid",
            passwordHash: "test",
            role: "veterinarian",
          },
          {
            practiceId: b!.id,
            name: "Other Doctor",
            email: "dup-b@example.invalid",
            passwordHash: "test",
            role: "veterinarian",
          },
        ])
        .returning();
      const [product] = await ownerDb
        .insert(schema.products)
        .values({
          practiceId: a!.id,
          name: "Synthetic Gauze",
          unitPrice: "1.00",
          stockQuantity: 5,
        })
        .returning();

      const caller = (practiceId = a!.id, userId = vet!.id) =>
        router.createCaller({
          db: appDb,
          session: {
            user: {
              id: userId,
              practiceId,
              role: "veterinarian",
              email: "dup@example.invalid",
              name: "Synthetic Doctor",
            },
          },
        } as never);

      // Controlled substances: a double-clicked submission is one entry.
      const entry = {
        operationId: randomUUID(),
        drugName: "Ketamine",
        deaSchedule: "III" as const,
        action: "received" as const,
        quantity: "10",
        unit: "ml",
        lotNumber: "LOT-1",
      };
      const [first, second] = await Promise.all([
        caller().controlledSubstances.create(entry),
        caller().controlledSubstances.create(entry),
      ]);
      expect(second.id).toBe(first.id);
      expect((await caller().controlledSubstances.create(entry)).id).toBe(
        first.id,
      );
      await expect(
        caller().controlledSubstances.create({ ...entry, quantity: "11" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const logRows = await ownerDb
        .select()
        .from(schema.controlledSubstanceLog)
        .where(eq(schema.controlledSubstanceLog.practiceId, a!.id));
      expect(logRows).toHaveLength(1);
      const [summary] = await caller().controlledSubstances.summary({});
      expect(Number(summary!.totalReceived)).toBe(10);

      // A new submission is a new entry; another clinic may reuse the id.
      await caller().controlledSubstances.create({
        ...entry,
        operationId: randomUUID(),
      });
      await caller(b!.id, otherVet!.id).controlledSubstances.create(entry);
      const [summaryAfter] = await caller().controlledSubstances.summary({});
      expect(Number(summaryAfter!.totalReceived)).toBe(20);

      // The database rejects a duplicate key even without the app guard;
      // entries written before the key existed stay valid.
      const duplicate = {
        practiceId: a!.id,
        drugName: "Ketamine",
        deaSchedule: "III",
        action: "received" as const,
        quantity: "1",
        unit: "ml",
        performedBy: vet!.id,
      };
      await expect(
        ownerDb
          .insert(schema.controlledSubstanceLog)
          .values({ ...duplicate, operationId: entry.operationId }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: "23505",
          constraint_name: "cs_log_practice_operation_uq",
        }),
      });
      await ownerDb
        .insert(schema.controlledSubstanceLog)
        .values([duplicate, duplicate]);

      // Inventory: a double-clicked "+ Add 3" moves stock once (5 -> 8).
      const adjustment = {
        id: product!.id,
        adjustment: 3,
        reason: "Received order",
        operationId: randomUUID(),
      };
      const [added, addedAgain] = await Promise.all([
        caller().inventory.adjustStock(adjustment),
        caller().inventory.adjustStock(adjustment),
      ]);
      expect(added.stockQuantity).toBe(8);
      expect(addedAgain.stockQuantity).toBe(8);
      await expect(
        caller().inventory.adjustStock({ ...adjustment, adjustment: 4 }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      // Callers that send no id still get a recorded, non-deduplicated move.
      await caller().inventory.adjustStock({
        id: product!.id,
        adjustment: -1,
        reason: "Cycle count",
      });
      const [stock] = await ownerDb
        .select({ stockQuantity: schema.products.stockQuantity })
        .from(schema.products)
        .where(eq(schema.products.id, product!.id));
      expect(stock!.stockQuantity).toBe(7);
      const movements = await ownerDb
        .select()
        .from(schema.inventoryStockAdjustments)
        .where(eq(schema.inventoryStockAdjustments.productId, product!.id));
      expect(
        movements
          .map((row) => [row.adjustment, row.quantityAfter, row.adjustedBy])
          .sort(),
      ).toEqual(
        [
          [3, 8, vet!.id],
          [-1, 7, vet!.id],
        ].sort(),
      );

      // Stock movements are tenant-isolated and append-only for the app role.
      await expect(
        caller(b!.id, otherVet!.id).inventory.adjustStock({
          ...adjustment,
          operationId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        app`update inventory_stock_adjustments set reason = 'tampered'`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app`delete from inventory_stock_adjustments`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        ownerDb.insert(schema.inventoryStockAdjustments).values({
          practiceId: b!.id,
          productId: product!.id,
          operationId: randomUUID(),
          adjustment: 1,
          quantityAfter: 1,
          reason: "Cross-clinic",
          adjustedBy: otherVet!.id,
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: "23503",
          constraint_name: "inventory_stock_adjustments_practice_product_fk",
        }),
      });
    } finally {
      await app?.end();
      await owner?.end();
      await admin.unsafe(`drop database if exists "${databaseName}"`);
      await admin.end();
    }
  }, 120_000);
});
