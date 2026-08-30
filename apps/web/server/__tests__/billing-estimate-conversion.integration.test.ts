import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

const repoRoot = resolve(process.cwd(), "../..");
type SqlClient = ReturnType<typeof postgres>;
const describeWithPostgres =
  process.env.BILLING_CONVERSION_DB_INTEGRATION === "1"
    ? describe.sequential
    : describe.skip;

function runPnpm(args: string[], databaseUrl: string): void {
  const pnpmCliPath = process.env.PNPM_CLI_PATH?.trim();
  execFileSync(
    pnpmCliPath ? process.execPath : "pnpm",
    pnpmCliPath ? [pnpmCliPath, ...args] : args,
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf8",
    },
  );
}

async function within<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForBlockedQueries(
  sql: SqlClient,
  databaseName: string,
  minimum: number,
  queryPattern = "%",
): Promise<void> {
  await within(
    (async () => {
      for (;;) {
        const [row] = await sql<Array<{ count: number }>>`
          select count(*)::int as count
          from pg_stat_activity
          where datname = ${databaseName}
            and wait_event_type = 'Lock'
            and query ilike ${queryPattern}
        `;
        if ((row?.count ?? 0) >= minimum) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    })(),
    `${minimum} blocked product queries`,
  );
}

function waitForBlockedProductQueries(
  sql: SqlClient,
  databaseName: string,
  minimum: number,
) {
  return waitForBlockedQueries(sql, databaseName, minimum, "%products%");
}

function rejectionDetails(reason: unknown): string {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = reason;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) details.push(current.message);
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (typeof record.code === "string") details.push(record.code);
      current = record.cause;
    } else {
      details.push(String(current));
      break;
    }
  }
  return details.join(" | ");
}

function assertNoDeadlock(
  results: readonly PromiseSettledResult<unknown>[],
): void {
  for (const result of results) {
    if (result.status !== "rejected") continue;
    const details = rejectionDetails(result.reason);
    expect(details).not.toContain("40P01");
    expect(details.toLowerCase()).not.toContain("deadlock detected");
  }
}

function assertSingleDomainRejection(
  results: readonly PromiseSettledResult<unknown>[],
  code: string,
): void {
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  expect(rejected).toHaveLength(1);
  expect(rejectionDetails(rejected[0]!.reason)).toContain(code);
}

describeWithPostgres("atomic estimate conversion PostgreSQL contract", () => {
  it("serializes competing invoices and rolls back conversion failures under RLS", async () => {
    const adminUrl = process.env.DATABASE_URL?.trim();
    if (!adminUrl) throw new Error("DATABASE_URL is required");
    const hostname = new URL(adminUrl).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      throw new Error(
        "This drill is restricted to disposable local PostgreSQL",
      );
    }
    const appPassword = process.env.OPENPIMS_APP_DB_PASSWORD?.trim();
    if (!appPassword) throw new Error("OPENPIMS_APP_DB_PASSWORD is required");

    const databaseName = `openpims_estimate_conversion_${randomUUID().replaceAll("-", "")}`;
    if (!/^openpims_estimate_conversion_[a-f0-9]+$/.test(databaseName)) {
      throw new Error("unsafe disposable database name");
    }
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    databaseUrl.search = "";
    databaseUrl.hash = "";
    const appUrl = new URL(databaseUrl);
    appUrl.username = "openpims_app";
    appUrl.password = appPassword;

    const originalDatabaseUrl = process.env.DATABASE_URL;
    const adminSql = postgres(adminUrl, { max: 1 });
    let ownerSql: ReturnType<typeof postgres> | undefined;
    let appSql: ReturnType<typeof postgres> | undefined;
    let databaseCreated = false;

    try {
      await adminSql.unsafe(`create database "${databaseName}"`);
      databaseCreated = true;
      runPnpm(
        ["--filter", "@openpims/db", "db:migrate"],
        databaseUrl.toString(),
      );
      runPnpm(["--filter", "@openpims/db", "db:rls"], databaseUrl.toString());

      ownerSql = postgres(databaseUrl.toString(), { max: 1 });
      appSql = postgres(appUrl.toString(), { max: 8 });
      const ownerDb = drizzle(ownerSql, { schema });
      const appDb = drizzle(appSql, { schema });
      process.env.DATABASE_URL = appUrl.toString();
      const [{ billingRouter }, { recordsRouter }, { templatesRouter }] =
        await Promise.all([
          import("../routers/billing"),
          import("../routers/records"),
          import("../routers/templates"),
        ]);

      type Fixture = {
        practiceId: string;
        userId: string;
        locationId: string;
        clientId: string;
        patientId: string;
        appointmentId: string;
      };
      const createFixture = async (): Promise<Fixture> => {
        const fixture = {
          practiceId: randomUUID(),
          userId: randomUUID(),
          locationId: randomUUID(),
          clientId: randomUUID(),
          patientId: randomUUID(),
          appointmentId: randomUUID(),
        };
        await ownerDb.insert(schema.practices).values({
          id: fixture.practiceId,
          name: `Synthetic conversion clinic ${fixture.practiceId}`,
        });
        await ownerDb.insert(schema.users).values({
          id: fixture.userId,
          practiceId: fixture.practiceId,
          email: `conversion-${fixture.userId}@example.invalid`,
          passwordHash: "synthetic-not-a-login",
          name: "Synthetic billing operator",
          role: "admin",
        });
        await ownerDb.insert(schema.locations).values({
          id: fixture.locationId,
          practiceId: fixture.practiceId,
          name: "Synthetic location",
          isPrimary: true,
        });
        await ownerDb.insert(schema.clients).values({
          id: fixture.clientId,
          practiceId: fixture.practiceId,
          firstName: "Synthetic",
          lastName: "Client",
        });
        await ownerDb.insert(schema.patients).values({
          id: fixture.patientId,
          practiceId: fixture.practiceId,
          clientId: fixture.clientId,
          name: "Synthetic Patient",
          species: "canine",
        });
        await ownerDb.insert(schema.appointments).values({
          id: fixture.appointmentId,
          practiceId: fixture.practiceId,
          locationId: fixture.locationId,
          startTime: new Date("2026-08-25T14:00:00.000Z"),
          endTime: new Date("2026-08-25T15:00:00.000Z"),
          patientId: fixture.patientId,
          clientId: fixture.clientId,
          status: "in_exam",
        });
        return fixture;
      };
      const createProduct = async (
        fixture: Fixture,
        stockQuantity: number,
        inventoryTracked = true,
      ) => {
        const id = randomUUID();
        await ownerDb.insert(schema.products).values({
          id,
          practiceId: fixture.practiceId,
          locationId: fixture.locationId,
          name: `Synthetic product ${id}`,
          unitPrice: "15.00",
          taxable: true,
          inventoryTracked,
          stockQuantity,
          reorderPoint: inventoryTracked ? 10 : null,
        });
        return id;
      };
      type EstimateLine = {
        productId: string;
        quantity: number;
      };
      const createEstimate = async (
        fixture: Fixture,
        lines: EstimateLine[],
      ) => {
        const id = randomUUID();
        const updatedAt = new Date();
        const subtotal = lines.reduce(
          (sum, line) => sum + line.quantity * 15,
          0,
        );
        await ownerDb.insert(schema.invoices).values({
          id,
          practiceId: fixture.practiceId,
          clientId: fixture.clientId,
          patientId: fixture.patientId,
          appointmentId: fixture.appointmentId,
          status: "draft",
          subtotal: subtotal.toFixed(2),
          tax: "0.00",
          total: subtotal.toFixed(2),
          paidAmount: "0.00",
          isEstimate: true,
          updatedAt,
        });
        await ownerDb.insert(schema.invoiceItems).values(
          lines.map((line) => ({
            invoiceId: id,
            description: `Synthetic product ${line.productId}`,
            quantity: line.quantity,
            unitPrice: "15.00",
            total: (line.quantity * 15).toFixed(2),
            taxable: true,
            itemType: "product" as const,
            itemId: line.productId,
          })),
        );
        return { id, updatedAt };
      };
      const createProductTemplate = async (
        fixture: Fixture,
        productId: string,
      ) => {
        const id = randomUUID();
        await ownerDb.insert(schema.treatmentTemplates).values({
          id,
          practiceId: fixture.practiceId,
          name: `Synthetic medication template ${id}`,
        });
        await ownerDb.insert(schema.treatmentTemplateItems).values({
          templateId: id,
          itemType: "product",
          itemId: productId,
          description: "Synthetic templated medication",
          defaultQuantity: 2,
          defaultUnitPrice: "15.00",
          sortOrder: 0,
        });
        return id;
      };
      const callerContext = (fixture: Fixture) =>
        ({
          db: appDb,
          session: {
            user: {
              id: fixture.userId,
              email: `conversion-${fixture.userId}@example.invalid`,
              name: "Synthetic billing operator",
              role: "admin",
              practiceId: fixture.practiceId,
            },
          },
        }) as never;
      const caller = (fixture: Fixture) =>
        billingRouter.createCaller(callerContext(fixture));
      const recordsCaller = (fixture: Fixture) =>
        recordsRouter.createCaller(callerContext(fixture));
      const templatesCaller = (fixture: Fixture) =>
        templatesRouter.createCaller(callerContext(fixture));
      const stock = async (productId: string) => {
        const [row] = await ownerDb
          .select({ stockQuantity: schema.products.stockQuantity })
          .from(schema.products)
          .where(eq(schema.products.id, productId));
        return row?.stockQuantity;
      };
      const conversionAuditCount = async (practiceId: string) => {
        const rows = await ownerDb
          .select({ id: schema.auditLog.id })
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.practiceId, practiceId),
              eq(schema.auditLog.action, "estimate_converted"),
            ),
          );
        return rows.length;
      };

      const [appIdentity] = await appSql<
        Array<{ currentUser: string }>
      >`select current_user as "currentUser"`;
      expect(appIdentity?.currentUser).toBe("openpims_app");
      const [noContext] = await appSql<Array<{ count: number }>>`
        select count(*)::int as count from invoices
      `;
      expect(noContext?.count).toBe(0);

      // Two confirmations for one visit converge on one actual invoice. The
      // untracked catalog product remains billable but never changes stock.
      const raceFixture = await createFixture();
      const otherTenantFixture = await createFixture();
      const otherTenantProduct = await createProduct(otherTenantFixture, 9);
      const otherTenantEstimate = await createEstimate(otherTenantFixture, [
        { productId: otherTenantProduct, quantity: 2 },
      ]);
      const otherTenantTemplate = await createProductTemplate(
        otherTenantFixture,
        otherTenantProduct,
      );
      await expect(
        templatesCaller(raceFixture).applyToInvoice({
          templateId: otherTenantTemplate,
          invoiceId: otherTenantEstimate.id,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        caller(raceFixture).convertEstimateToInvoice({
          id: otherTenantEstimate.id,
          expectedUpdatedAt: otherTenantEstimate.updatedAt,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await stock(otherTenantProduct)).toBe(9);
      const [otherTenantState] = await ownerDb
        .select({ isEstimate: schema.invoices.isEstimate })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, otherTenantEstimate.id));
      expect(otherTenantState?.isEstimate).toBe(true);
      expect(await conversionAuditCount(otherTenantFixture.practiceId)).toBe(0);

      // Template application is a versioned invoice mutation. A confirmation
      // captured before the template edit must not deduct stock or convert the
      // now-stale estimate.
      const staleTemplateFixture = await createFixture();
      const staleTemplateProduct = await createProduct(staleTemplateFixture, 7);
      const staleTemplateEstimate = await createEstimate(staleTemplateFixture, [
        { productId: staleTemplateProduct, quantity: 2 },
      ]);
      const templateId = randomUUID();
      await ownerDb.insert(schema.treatmentTemplates).values({
        id: templateId,
        practiceId: staleTemplateFixture.practiceId,
        name: "Synthetic stale confirmation template",
      });
      await ownerDb.insert(schema.treatmentTemplateItems).values({
        templateId,
        itemType: "service",
        description: "Synthetic template service",
        defaultQuantity: 1,
        defaultUnitPrice: "5.00",
        sortOrder: 0,
      });
      const templateApplied = await templatesCaller(
        staleTemplateFixture,
      ).applyToInvoice({
        templateId,
        invoiceId: staleTemplateEstimate.id,
      });
      expect(templateApplied.updatedAt.getTime()).toBeGreaterThanOrEqual(
        staleTemplateEstimate.updatedAt.getTime() + 1,
      );
      await expect(
        caller(staleTemplateFixture).convertEstimateToInvoice({
          id: staleTemplateEstimate.id,
          expectedUpdatedAt: staleTemplateEstimate.updatedAt,
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Estimate changed. Refresh before converting it.",
      });
      expect(await stock(staleTemplateProduct)).toBe(7);
      expect(await conversionAuditCount(staleTemplateFixture.practiceId)).toBe(
        0,
      );
      const [staleTemplateState] = await ownerDb
        .select({ isEstimate: schema.invoices.isEstimate })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, staleTemplateEstimate.id));
      expect(staleTemplateState?.isEstimate).toBe(true);

      // A standalone refill can hold the product lock before its queue row is
      // visible. Force that order: the template's first evidence read sees no
      // queue row, then waits behind the refill on the product. Its post-lock
      // recheck must observe the committed queue work and roll back every
      // template write without deducting the medication a second time.
      const templateRefillFixture = await createFixture();
      const templateRefillProduct = await createProduct(
        templateRefillFixture,
        10,
      );
      const templateRefillPrescription = randomUUID();
      await ownerDb.insert(schema.prescriptions).values({
        id: templateRefillPrescription,
        practiceId: templateRefillFixture.practiceId,
        patientId: templateRefillFixture.patientId,
        appointmentId: null,
        medicationName: "Synthetic standalone refill medication",
        dosage: "25 mg",
        frequency: "Once daily",
        quantity: 2,
        productId: templateRefillProduct,
        refillsRemaining: 1,
        prescribedBy: templateRefillFixture.userId,
        operationId: randomUUID(),
        startDate: "2026-08-01",
        status: "active",
      });
      await ownerDb.insert(schema.prescriptionEvents).values({
        practiceId: templateRefillFixture.practiceId,
        prescriptionId: templateRefillPrescription,
        patientId: templateRefillFixture.patientId,
        productId: templateRefillProduct,
        eventType: "created",
        quantity: 2,
        statusBefore: null,
        statusAfter: "active",
        refillsBefore: null,
        refillsAfter: 1,
        actorId: templateRefillFixture.userId,
        actorName: "Synthetic billing operator",
      });
      const templateRefillInvoice = await caller(
        templateRefillFixture,
      ).createInvoice({
        clientId: templateRefillFixture.clientId,
        patientId: templateRefillFixture.patientId,
        appointmentId: templateRefillFixture.appointmentId,
        isEstimate: false,
        items: [
          {
            description: "Synthetic exam service",
            quantity: 1,
            unitPrice: "5.00",
            itemType: "service",
          },
        ],
      });
      const templateRefillTemplate = await createProductTemplate(
        templateRefillFixture,
        templateRefillProduct,
      );
      const templateRefillVersion = templateRefillInvoice.updatedAt;
      let releaseProductBarrier!: () => void;
      const productBarrierRelease = new Promise<void>((resolveRelease) => {
        releaseProductBarrier = resolveRelease;
      });
      let markProductBarrierReady!: () => void;
      const productBarrierReady = new Promise<void>((resolveReady) => {
        markProductBarrierReady = resolveReady;
      });
      const productBarrier = ownerSql.begin(async (barrierTx) => {
        const barrierSql = barrierTx as unknown as SqlClient;
        await barrierSql`
          select id
          from products
          where id = ${templateRefillProduct}
          for update
        `;
        markProductBarrierReady();
        await productBarrierRelease;
      });
      await within(productBarrierReady, "template/refill product barrier");
      const refillAttempt = recordsCaller(
        templateRefillFixture,
      ).recordPrescriptionRefill({
        id: templateRefillPrescription,
        operationId: randomUUID(),
        note: "Synthetic ordered template/refill drill",
      });
      await waitForBlockedProductQueries(adminSql, databaseName, 1);
      const templateAttempt = templatesCaller(
        templateRefillFixture,
      ).applyToInvoice({
        templateId: templateRefillTemplate,
        invoiceId: templateRefillInvoice.id,
      });
      const templateRejection = expect(templateAttempt).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("medication billing queue"),
      });
      try {
        await waitForBlockedProductQueries(adminSql, databaseName, 2);
      } finally {
        releaseProductBarrier();
        await within(productBarrier, "template/refill product release");
      }
      await within(refillAttempt, "standalone refill completion");
      await within(templateRejection, "blocked template recheck");
      expect(await stock(templateRefillProduct)).toBe(8);
      const templateRefillQueue = await ownerDb
        .select({
          id: schema.dispenseChargeQueue.id,
          status: schema.dispenseChargeQueue.status,
        })
        .from(schema.dispenseChargeQueue)
        .where(
          eq(
            schema.dispenseChargeQueue.prescriptionId,
            templateRefillPrescription,
          ),
        );
      expect(templateRefillQueue).toEqual([
        { id: expect.any(String), status: "pending" },
      ]);
      const templateRefillItems = await ownerDb
        .select({ id: schema.invoiceItems.id })
        .from(schema.invoiceItems)
        .where(eq(schema.invoiceItems.invoiceId, templateRefillInvoice.id));
      expect(templateRefillItems).toHaveLength(1);
      const [templateRefillInvoiceState] = await ownerDb
        .select({ updatedAt: schema.invoices.updatedAt })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, templateRefillInvoice.id));
      expect(templateRefillInvoiceState?.updatedAt).toEqual(
        templateRefillVersion,
      );

      // Once that dispense is sourced to its own invoice, it is historical
      // evidence rather than unresolved work for the visit invoice. A deleted
      // prescription from the visit is likewise not a live source. Neither may
      // block a later explicitly applied product template.
      const historicalDispenseInvoice = await caller(
        templateRefillFixture,
      ).createDispenseChargeInvoice({
        id: templateRefillQueue[0]!.id,
        acknowledgeLegacyReview: false,
      });
      await ownerDb.insert(schema.prescriptions).values({
        id: randomUUID(),
        practiceId: templateRefillFixture.practiceId,
        patientId: templateRefillFixture.patientId,
        appointmentId: templateRefillFixture.appointmentId,
        medicationName: "Deleted synthetic visit medication",
        dosage: "25 mg",
        frequency: "Once daily",
        quantity: 2,
        productId: templateRefillProduct,
        refillsRemaining: 0,
        prescribedBy: templateRefillFixture.userId,
        operationId: randomUUID(),
        startDate: "2026-08-01",
        status: "active",
        deletedAt: new Date(),
      });
      await expect(
        templatesCaller(templateRefillFixture).applyToInvoice({
          templateId: templateRefillTemplate,
          invoiceId: templateRefillInvoice.id,
        }),
      ).resolves.toMatchObject({ id: templateRefillInvoice.id });
      expect(await stock(templateRefillProduct)).toBe(6);
      const templateRefillItemsAfterHistorical = await ownerDb
        .select({ id: schema.invoiceItems.id })
        .from(schema.invoiceItems)
        .where(eq(schema.invoiceItems.invoiceId, templateRefillInvoice.id));
      expect(templateRefillItemsAfterHistorical).toHaveLength(2);

      // updateInvoiceItems owns product -> sourced queue. Hold the product,
      // queue the historical source edit first, then queue the template. The
      // template must not pre-lock allowed invoiced-other evidence; both
      // operations complete without a cycle and only the template moves stock.
      await ownerDb
        .update(schema.invoices)
        .set({ updatedAt: new Date("2026-08-25T18:00:00.000Z") })
        .where(eq(schema.invoices.id, historicalDispenseInvoice.invoiceId));
      const [historicalInvoiceState] = await ownerDb
        .select({ updatedAt: schema.invoices.updatedAt })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, historicalDispenseInvoice.invoiceId));
      const [historicalInvoiceLine] = await ownerDb
        .select({
          description: schema.invoiceItems.description,
          quantity: schema.invoiceItems.quantity,
          unitPrice: schema.invoiceItems.unitPrice,
          itemType: schema.invoiceItems.itemType,
          itemId: schema.invoiceItems.itemId,
          sourceDispenseChargeId: schema.invoiceItems.sourceDispenseChargeId,
        })
        .from(schema.invoiceItems)
        .where(
          eq(
            schema.invoiceItems.invoiceId,
            historicalDispenseInvoice.invoiceId,
          ),
        );
      expect(historicalInvoiceState).toBeDefined();
      expect(historicalInvoiceLine?.sourceDispenseChargeId).toBe(
        templateRefillQueue[0]!.id,
      );
      let releaseHistoricalProductBarrier!: () => void;
      const historicalProductBarrierRelease = new Promise<void>(
        (resolveRelease) => {
          releaseHistoricalProductBarrier = resolveRelease;
        },
      );
      let markHistoricalProductBarrierReady!: () => void;
      const historicalProductBarrierReady = new Promise<void>(
        (resolveReady) => {
          markHistoricalProductBarrierReady = resolveReady;
        },
      );
      const historicalProductBarrier = ownerSql.begin(async (barrierTx) => {
        const barrierSql = barrierTx as unknown as SqlClient;
        await barrierSql`
          select id
          from products
          where id = ${templateRefillProduct}
          for update
        `;
        markHistoricalProductBarrierReady();
        await historicalProductBarrierRelease;
      });
      await within(
        historicalProductBarrierReady,
        "historical edit product barrier",
      );
      const historicalEditAttempt = caller(
        templateRefillFixture,
      ).updateInvoiceItems({
        id: historicalDispenseInvoice.invoiceId,
        expectedUpdatedAt: historicalInvoiceState!.updatedAt,
        items: [
          {
            description: historicalInvoiceLine!.description,
            quantity: historicalInvoiceLine!.quantity,
            unitPrice: historicalInvoiceLine!.unitPrice,
            itemType: historicalInvoiceLine!.itemType,
            itemId: historicalInvoiceLine!.itemId ?? undefined,
            sourceDispenseChargeId:
              historicalInvoiceLine!.sourceDispenseChargeId ?? undefined,
          },
        ],
      });
      await waitForBlockedProductQueries(adminSql, databaseName, 1);
      const historicalTemplateAttempt = templatesCaller(
        templateRefillFixture,
      ).applyToInvoice({
        templateId: templateRefillTemplate,
        invoiceId: templateRefillInvoice.id,
      });
      try {
        await waitForBlockedProductQueries(adminSql, databaseName, 2);
      } finally {
        releaseHistoricalProductBarrier();
        await within(
          historicalProductBarrier,
          "historical edit product release",
        );
      }
      const historicalSchedule = await within(
        Promise.allSettled([historicalEditAttempt, historicalTemplateAttempt]),
        "historical edit/template schedule",
      );
      assertNoDeadlock(historicalSchedule);
      expect(
        historicalSchedule.map((result) =>
          result.status === "fulfilled"
            ? "fulfilled"
            : rejectionDetails(result.reason),
        ),
      ).toEqual(["fulfilled", "fulfilled"]);
      expect(await stock(templateRefillProduct)).toBe(4);

      // createDispenseChargeInvoice owns appointment -> invoice. Create a
      // visit-linked refill, hold the invoice row, and let the dispense path
      // acquire the appointment boundary before the template starts. The
      // template must wait on that same appointment order, then reject the now
      // sourced medication without deadlocking or moving stock again.
      await ownerDb
        .update(schema.prescriptions)
        .set({ refillsRemaining: 1 })
        .where(eq(schema.prescriptions.id, templateRefillPrescription));
      await recordsCaller(templateRefillFixture).recordPrescriptionRefill({
        id: templateRefillPrescription,
        operationId: randomUUID(),
        appointmentId: templateRefillFixture.appointmentId,
        note: "Synthetic visit-linked template/dispense drill",
      });
      const [visitDispense] = await ownerDb
        .select({ id: schema.dispenseChargeQueue.id })
        .from(schema.dispenseChargeQueue)
        .where(
          and(
            eq(
              schema.dispenseChargeQueue.prescriptionId,
              templateRefillPrescription,
            ),
            eq(
              schema.dispenseChargeQueue.appointmentId,
              templateRefillFixture.appointmentId,
            ),
            eq(schema.dispenseChargeQueue.status, "pending"),
          ),
        );
      expect(visitDispense).toBeDefined();
      expect(await stock(templateRefillProduct)).toBe(2);
      let releaseVisitInvoiceBarrier!: () => void;
      const visitInvoiceBarrierRelease = new Promise<void>((resolveRelease) => {
        releaseVisitInvoiceBarrier = resolveRelease;
      });
      let markVisitInvoiceBarrierReady!: () => void;
      const visitInvoiceBarrierReady = new Promise<void>((resolveReady) => {
        markVisitInvoiceBarrierReady = resolveReady;
      });
      const visitInvoiceBarrier = ownerSql.begin(async (barrierTx) => {
        const barrierSql = barrierTx as unknown as SqlClient;
        await barrierSql`
          select id
          from invoices
          where id = ${templateRefillInvoice.id}
          for update
        `;
        markVisitInvoiceBarrierReady();
        await visitInvoiceBarrierRelease;
      });
      await within(visitInvoiceBarrierReady, "visit invoice barrier");
      const createDispenseAttempt = caller(
        templateRefillFixture,
      ).createDispenseChargeInvoice({
        id: visitDispense!.id,
        acknowledgeLegacyReview: false,
      });
      await waitForBlockedQueries(adminSql, databaseName, 1, "%invoices%");
      const orderedTemplateAttempt = templatesCaller(
        templateRefillFixture,
      ).applyToInvoice({
        templateId: templateRefillTemplate,
        invoiceId: templateRefillInvoice.id,
      });
      const orderedTemplateRejection = expect(
        orderedTemplateAttempt,
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("medication billing queue"),
      });
      try {
        await waitForBlockedQueries(adminSql, databaseName, 2);
      } finally {
        releaseVisitInvoiceBarrier();
        await within(visitInvoiceBarrier, "visit invoice barrier release");
      }
      await within(createDispenseAttempt, "visit dispense creation");
      await within(orderedTemplateRejection, "ordered template rejection");
      expect(await stock(templateRefillProduct)).toBe(2);
      const [visitDispenseState] = await ownerDb
        .select({
          status: schema.dispenseChargeQueue.status,
          invoiceId: schema.dispenseChargeQueue.invoiceId,
        })
        .from(schema.dispenseChargeQueue)
        .where(eq(schema.dispenseChargeQueue.id, visitDispense!.id));
      expect(visitDispenseState).toEqual({
        status: "invoiced",
        invoiceId: templateRefillInvoice.id,
      });

      const trackedProduct = await createProduct(raceFixture, 10, true);
      const untrackedProduct = await createProduct(raceFixture, 0, false);
      const raceLines = [
        { productId: trackedProduct, quantity: 2 },
        { productId: untrackedProduct, quantity: 50 },
      ];
      const firstEstimate = await createEstimate(raceFixture, raceLines);
      const secondEstimate = await createEstimate(raceFixture, raceLines);
      const conversionRace = await within(
        Promise.allSettled([
          caller(raceFixture).convertEstimateToInvoice({
            id: firstEstimate.id,
            expectedUpdatedAt: firstEstimate.updatedAt,
          }),
          caller(raceFixture).convertEstimateToInvoice({
            id: secondEstimate.id,
            expectedUpdatedAt: secondEstimate.updatedAt,
          }),
        ]),
        "competing estimate conversion",
      );
      assertNoDeadlock(conversionRace);
      assertSingleDomainRejection(conversionRace, "CONFLICT");
      expect(
        conversionRace.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        conversionRace.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(await stock(trackedProduct)).toBe(8);
      expect(await stock(untrackedProduct)).toBe(0);
      expect(await conversionAuditCount(raceFixture.practiceId)).toBe(1);

      // Exact duplicate confirmations serialize on the invoice key. One wins;
      // the second observes the converted row and cannot repeat stock/audit.
      const duplicateFixture = await createFixture();
      const duplicateProduct = await createProduct(duplicateFixture, 10);
      const duplicateEstimate = await createEstimate(duplicateFixture, [
        { productId: duplicateProduct, quantity: 2 },
      ]);
      const duplicateRace = await within(
        Promise.allSettled([
          caller(duplicateFixture).convertEstimateToInvoice({
            id: duplicateEstimate.id,
            expectedUpdatedAt: duplicateEstimate.updatedAt,
          }),
          caller(duplicateFixture).convertEstimateToInvoice({
            id: duplicateEstimate.id,
            expectedUpdatedAt: duplicateEstimate.updatedAt,
          }),
        ]),
        "duplicate estimate conversion",
      );
      assertNoDeadlock(duplicateRace);
      expect(
        duplicateRace.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      assertSingleDomainRejection(duplicateRace, "CONFLICT");
      const duplicateRejection = duplicateRace.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(rejectionDetails(duplicateRejection?.reason)).toContain(
        "Estimate changed. Refresh before converting it.",
      );
      expect(await stock(duplicateProduct)).toBe(8);
      expect(await conversionAuditCount(duplicateFixture.practiceId)).toBe(1);

      // Hold the estimate's serialization key so an older/unlinked
      // prescription refill can commit its visit-linked queue work first.
      // Conversion must then revalidate that work and fail without a second
      // stock movement.
      const refillFixture = await createFixture();
      const refillProduct = await createProduct(refillFixture, 10);
      const prescriptionId = randomUUID();
      await ownerDb.insert(schema.prescriptions).values({
        id: prescriptionId,
        practiceId: refillFixture.practiceId,
        patientId: refillFixture.patientId,
        appointmentId: null,
        medicationName: "Synthetic medication",
        dosage: "25 mg",
        frequency: "Once daily",
        quantity: 2,
        productId: refillProduct,
        refillsRemaining: 1,
        prescribedBy: refillFixture.userId,
        operationId: randomUUID(),
        startDate: "2026-08-01",
        status: "active",
      });
      await ownerDb.insert(schema.prescriptionEvents).values({
        practiceId: refillFixture.practiceId,
        prescriptionId,
        patientId: refillFixture.patientId,
        productId: refillProduct,
        eventType: "created",
        quantity: 2,
        statusBefore: null,
        statusAfter: "active",
        refillsBefore: null,
        refillsAfter: 1,
        actorId: refillFixture.userId,
        actorName: "Synthetic billing operator",
      });
      const refillEstimate = await createEstimate(refillFixture, [
        { productId: refillProduct, quantity: 2 },
      ]);
      let releaseInvoiceBarrier!: () => void;
      const invoiceBarrierRelease = new Promise<void>((resolveRelease) => {
        releaseInvoiceBarrier = resolveRelease;
      });
      let markInvoiceBarrierReady!: () => void;
      const invoiceBarrierReady = new Promise<void>((resolveReady) => {
        markInvoiceBarrierReady = resolveReady;
      });
      const invoiceBarrier = appSql.begin(async (barrierTx) => {
        const barrierSql = barrierTx as unknown as SqlClient;
        await barrierSql`
          select pg_advisory_xact_lock(
            hashtextextended(${refillEstimate.id}, 0)
          )
        `;
        markInvoiceBarrierReady();
        await invoiceBarrierRelease;
      });
      await within(invoiceBarrierReady, "invoice barrier acquisition");
      let conversionSettled = false;
      const blockedConversion = caller(refillFixture).convertEstimateToInvoice({
        id: refillEstimate.id,
        expectedUpdatedAt: refillEstimate.updatedAt,
      });
      void blockedConversion.then(
        () => {
          conversionSettled = true;
        },
        () => {
          conversionSettled = true;
        },
      );
      try {
        await within(
          recordsCaller(refillFixture).recordPrescriptionRefill({
            id: prescriptionId,
            operationId: randomUUID(),
            appointmentId: refillFixture.appointmentId,
            note: "Synthetic ordered conversion/refill drill",
          }),
          "ordered refill commit",
        );
        expect(conversionSettled).toBe(false);
      } finally {
        releaseInvoiceBarrier();
        await within(invoiceBarrier, "invoice barrier release");
      }
      await expect(
        within(blockedConversion, "blocked conversion revalidation"),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Charge this patient's already-dispensed medication from the medication billing queue so inventory is not deducted twice.",
      });
      expect(await stock(refillProduct)).toBe(8);
      const [refillState] = await ownerDb
        .select({ refillsRemaining: schema.prescriptions.refillsRemaining })
        .from(schema.prescriptions)
        .where(eq(schema.prescriptions.id, prescriptionId));
      expect(refillState?.refillsRemaining).toBe(0);
      const refillQueue = await ownerDb
        .select({ status: schema.dispenseChargeQueue.status })
        .from(schema.dispenseChargeQueue)
        .where(eq(schema.dispenseChargeQueue.prescriptionId, prescriptionId));
      expect(refillQueue).toEqual([{ status: "pending" }]);
      expect(await conversionAuditCount(refillFixture.practiceId)).toBe(0);
      const [blockedEstimateState] = await ownerDb
        .select({ isEstimate: schema.invoices.isEstimate })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, refillEstimate.id));
      expect(blockedEstimateState?.isEstimate).toBe(true);

      // A later insufficient row rolls back an earlier successful stock update,
      // the estimate flip, and its audit as one transaction.
      const rollbackFixture = await createFixture();
      const sufficientProduct = await createProduct(rollbackFixture, 10);
      const insufficientProduct = await createProduct(rollbackFixture, 1);
      const rollbackEstimate = await createEstimate(rollbackFixture, [
        { productId: sufficientProduct, quantity: 2 },
        { productId: insufficientProduct, quantity: 2 },
      ]);
      await expect(
        caller(rollbackFixture).convertEstimateToInvoice({
          id: rollbackEstimate.id,
          expectedUpdatedAt: rollbackEstimate.updatedAt,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await stock(sufficientProduct)).toBe(10);
      expect(await stock(insufficientProduct)).toBe(1);
      const [rollbackState] = await ownerDb
        .select({ isEstimate: schema.invoices.isEstimate })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, rollbackEstimate.id));
      expect(rollbackState?.isEstimate).toBe(true);
      expect(await conversionAuditCount(rollbackFixture.practiceId)).toBe(0);

      // Conversion and actual-invoice creation share the appointment lock, so
      // exactly one wins and inventory is deducted exactly once.
      const createRaceFixture = await createFixture();
      const createRaceProduct = await createProduct(createRaceFixture, 10);
      const createRaceEstimate = await createEstimate(createRaceFixture, [
        { productId: createRaceProduct, quantity: 2 },
      ]);
      const createRace = await within(
        Promise.allSettled([
          caller(createRaceFixture).convertEstimateToInvoice({
            id: createRaceEstimate.id,
            expectedUpdatedAt: createRaceEstimate.updatedAt,
          }),
          caller(createRaceFixture).createInvoice({
            clientId: createRaceFixture.clientId,
            patientId: createRaceFixture.patientId,
            appointmentId: createRaceFixture.appointmentId,
            isEstimate: false,
            items: [
              {
                description: "Synthetic product",
                quantity: 2,
                unitPrice: "15.00",
                itemType: "product",
                itemId: createRaceProduct,
              },
            ],
          }),
        ]),
        "conversion/create serialization",
      );
      assertNoDeadlock(createRace);
      assertSingleDomainRejection(createRace, "CONFLICT");
      expect(
        createRace.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        createRace.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(await stock(createRaceProduct)).toBe(8);
      const actualInvoices = await ownerDb
        .select({ id: schema.invoices.id })
        .from(schema.invoices)
        .where(
          and(
            eq(schema.invoices.practiceId, createRaceFixture.practiceId),
            eq(schema.invoices.isEstimate, false),
          ),
        );
      expect(actualInvoices).toHaveLength(1);

      const [postRouteNoContext] = await appSql<Array<{ count: number }>>`
        select count(*)::int as count from invoices
      `;
      expect(postRouteNoContext?.count).toBe(0);
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
      if (appSql) await appSql.end();
      if (ownerSql) await ownerSql.end();
      try {
        if (databaseCreated) {
          await adminSql.unsafe(
            `drop database if exists "${databaseName}" with (force)`,
          );
        }
      } finally {
        await adminSql.end();
      }
    }
  }, 120_000);
});
