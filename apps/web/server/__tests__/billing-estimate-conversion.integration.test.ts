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
      const [{ billingRouter }, { recordsRouter }] = await Promise.all([
        import("../routers/billing"),
        import("../routers/records"),
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

      // Slice A and conversion now share appointment-first row locking after
      // the invoice advisory lock. A same-visit refill must win without a
      // deadlock, while the unsourced medication estimate fails closed.
      const refillFixture = await createFixture();
      const refillProduct = await createProduct(refillFixture, 10);
      const prescriptionId = randomUUID();
      await ownerDb.insert(schema.prescriptions).values({
        id: prescriptionId,
        practiceId: refillFixture.practiceId,
        patientId: refillFixture.patientId,
        appointmentId: refillFixture.appointmentId,
        medicationName: "Synthetic medication",
        dosage: "25 mg",
        frequency: "Once daily",
        quantity: 2,
        productId: refillProduct,
        refillsRemaining: 1,
        prescribedBy: refillFixture.userId,
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
      const refillRace = await within(
        Promise.allSettled([
          caller(refillFixture).convertEstimateToInvoice({
            id: refillEstimate.id,
            expectedUpdatedAt: refillEstimate.updatedAt,
          }),
          recordsCaller(refillFixture).recordPrescriptionRefill({
            id: prescriptionId,
            operationId: randomUUID(),
            appointmentId: refillFixture.appointmentId,
            note: "Synthetic conversion/refill drill",
          }),
        ]),
        "conversion/refill serialization",
      );
      assertNoDeadlock(refillRace);
      expect(refillRace[0]).toEqual(
        expect.objectContaining({ status: "rejected" }),
      );
      expect(refillRace[1]).toEqual(
        expect.objectContaining({ status: "fulfilled" }),
      );
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
