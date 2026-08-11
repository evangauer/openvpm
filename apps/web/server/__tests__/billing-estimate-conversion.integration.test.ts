import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  appointments,
  auditLog,
  clients,
  dispenseChargeQueue,
  invoiceItems,
  invoices,
  locations,
  patients,
  practices,
  prescriptionEvents,
  prescriptions,
  products,
  services,
  treatmentTemplateItems,
  treatmentTemplates,
  users,
  visitCloseouts,
  visitWorkItems,
} from "@openpims/db";
import { db } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

const { billingRouter } = await import("../routers/billing");
const { encountersRouter } = await import("../routers/encounters");
const { recordsRouter } = await import("../routers/records");
const { templatesRouter } = await import("../routers/templates");

const describeWithPostgres = process.env.BILLING_CONVERSION_DB_INTEGRATION
  ? describe.sequential
  : describe.skip;

type Fixture = {
  practiceId: string;
  userId: string;
  clientId: string;
  patientId: string;
  appointmentId: string;
  locationId: string;
  serviceId: string;
};

type ProductFixture = {
  id: string;
  stockQuantity: number;
};

type PrescriptionFixture = {
  id: string;
  eventId: string;
  productId: string;
};

const fixtures = new Set<string>();

function assertDisposableLocalDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for the billing conversion drill",
    );
  }
  const hostname = new URL(databaseUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(
      "The billing conversion drill is restricted to disposable local PostgreSQL",
    );
  }
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

function callerContext(fixture: Fixture) {
  return {
    db,
    session: {
      user: {
        id: fixture.userId,
        email: `synthetic-${fixture.userId}@example.invalid`,
        name: "Synthetic billing operator",
        role: "admin" as const,
        practiceId: fixture.practiceId,
      },
    },
    ip: "192.0.2.1",
  };
}

function billingCaller(fixture: Fixture) {
  return billingRouter.createCaller(callerContext(fixture) as never);
}

function recordsCaller(fixture: Fixture) {
  return recordsRouter.createCaller(callerContext(fixture) as never);
}

function encountersCaller(fixture: Fixture) {
  return encountersRouter.createCaller(callerContext(fixture) as never);
}

function templatesCaller(fixture: Fixture) {
  return templatesRouter.createCaller(callerContext(fixture) as never);
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

function expectOneDomainRejection(
  results: readonly PromiseSettledResult<unknown>[],
  allowedMessages: readonly string[],
): void {
  assertNoDeadlock(results);
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.reason).toMatchObject({ code: "CONFLICT" });
  expect(allowedMessages).toContain(rejected[0]!.reason.message);
}

async function createFixture(): Promise<Fixture> {
  const practiceId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const patientId = randomUUID();
  const appointmentId = randomUUID();
  const locationId = randomUUID();
  const serviceId = randomUUID();
  const now = new Date();

  await withSystem(db, async (tx) => {
    await tx.insert(practices).values({
      id: practiceId,
      name: `Synthetic billing drill ${practiceId}`,
      taxRatePercent: "8.00",
    });
    await tx.insert(users).values({
      id: userId,
      practiceId,
      email: `synthetic-${userId}@example.invalid`,
      passwordHash: "synthetic-not-a-login",
      name: "Synthetic billing operator",
      role: "admin",
      isVeterinarian: true,
    });
    await tx.insert(locations).values({
      id: locationId,
      practiceId,
      name: "Synthetic billing location",
      isPrimary: true,
    });
    await tx.insert(clients).values({
      id: clientId,
      practiceId,
      firstName: "Synthetic",
      lastName: "Client",
    });
    await tx.insert(patients).values({
      id: patientId,
      practiceId,
      clientId,
      name: "Synthetic Patient",
      species: "canine",
    });
    await tx.insert(appointments).values({
      id: appointmentId,
      practiceId,
      locationId,
      startTime: new Date(now.getTime() - 30 * 60_000),
      endTime: new Date(now.getTime() + 30 * 60_000),
      patientId,
      clientId,
      doctorId: userId,
      status: "in_exam",
    });
    await tx.insert(services).values({
      id: serviceId,
      practiceId,
      name: "Synthetic exam service",
      defaultPrice: "50.00",
      taxable: false,
    });
  });

  fixtures.add(practiceId);
  return {
    practiceId,
    userId,
    clientId,
    patientId,
    appointmentId,
    locationId,
    serviceId,
  };
}

async function createProduct(
  fixture: Fixture,
  stockQuantity = 10,
  id = randomUUID(),
): Promise<ProductFixture> {
  await withSystem(db, async (tx) => {
    await tx.insert(products).values({
      id,
      practiceId: fixture.practiceId,
      name: `Synthetic product ${id}`,
      unitPrice: "15.00",
      taxable: true,
      stockQuantity,
    });
  });
  return { id, stockQuantity };
}

async function createVisit(
  fixture: Fixture,
  id = randomUUID(),
): Promise<string> {
  await withSystem(db, async (tx) => {
    await tx.insert(appointments).values({
      id,
      practiceId: fixture.practiceId,
      locationId: fixture.locationId,
      startTime: new Date("2026-08-11T17:00:00.000Z"),
      endTime: new Date("2026-08-11T18:00:00.000Z"),
      patientId: fixture.patientId,
      clientId: fixture.clientId,
      doctorId: fixture.userId,
      status: "in_exam",
    });
  });
  return id;
}

async function createEstimate(
  fixture: Fixture,
  input: {
    id?: string;
    itemId?: string;
    itemType?: "service" | "product";
    quantity?: number;
    sourcePrescriptionId?: string;
    sourceDispenseChargeId?: string;
  } = {},
): Promise<{ id: string; updatedAt: Date; itemId: string }> {
  const id = input.id ?? randomUUID();
  const itemId = input.itemId ?? fixture.serviceId;
  const itemType = input.itemType ?? "service";
  const quantity = input.quantity ?? 1;
  const unitPrice = itemType === "product" ? "15.00" : "50.00";
  const updatedAt = new Date();
  const subtotal = (Number(unitPrice) * quantity).toFixed(2);

  await withSystem(db, async (tx) => {
    await tx.insert(invoices).values({
      id,
      practiceId: fixture.practiceId,
      clientId: fixture.clientId,
      patientId: fixture.patientId,
      appointmentId: fixture.appointmentId,
      status: "draft",
      subtotal,
      tax: "0.00",
      total: subtotal,
      paidAmount: "0.00",
      isEstimate: true,
      updatedAt,
    });
    await tx.insert(invoiceItems).values({
      id: randomUUID(),
      invoiceId: id,
      description: `Synthetic ${itemType}`,
      quantity,
      unitPrice,
      total: subtotal,
      taxable: itemType === "product",
      itemType,
      itemId,
      sourcePrescriptionId: input.sourcePrescriptionId ?? null,
      sourceDispenseChargeId: input.sourceDispenseChargeId ?? null,
    });
  });

  return { id, updatedAt, itemId };
}

async function createPrescription(
  fixture: Fixture,
  product: ProductFixture,
  appointmentId: string | null = fixture.appointmentId,
): Promise<PrescriptionFixture> {
  const id = randomUUID();
  const eventId = randomUUID();
  await withSystem(db, async (tx) => {
    await tx.insert(prescriptions).values({
      id,
      practiceId: fixture.practiceId,
      patientId: fixture.patientId,
      appointmentId,
      medicationName: "Synthetic medication",
      dosage: "Synthetic dose",
      frequency: "Once daily",
      quantity: 2,
      productId: product.id,
      refillsRemaining: 1,
      prescribedBy: fixture.userId,
      startDate: "2026-08-11",
      status: "active",
    });
    await tx.insert(prescriptionEvents).values({
      id: eventId,
      practiceId: fixture.practiceId,
      prescriptionId: id,
      patientId: fixture.patientId,
      productId: product.id,
      eventType: "created",
      quantity: 2,
      statusBefore: null,
      statusAfter: "active",
      refillsBefore: null,
      refillsAfter: 1,
      actorId: fixture.userId,
      actorName: "Synthetic billing operator",
    });
  });
  return { id, eventId, productId: product.id };
}

async function createPendingDispense(
  fixture: Fixture,
  prescription: PrescriptionFixture,
): Promise<string> {
  const id = randomUUID();
  await withSystem(db, async (tx) => {
    await tx.insert(dispenseChargeQueue).values({
      id,
      practiceId: fixture.practiceId,
      prescriptionEventId: prescription.eventId,
      prescriptionId: prescription.id,
      patientId: fixture.patientId,
      clientId: fixture.clientId,
      appointmentId: fixture.appointmentId,
      productId: prescription.productId,
      quantity: 2,
      descriptionSnapshot: "Synthetic medication dispense",
      unitPriceSnapshot: "15.00",
      status: "pending",
    });
  });
  return id;
}

async function createServiceTemplate(fixture: Fixture): Promise<string> {
  const templateId = randomUUID();
  await withSystem(db, async (tx) => {
    await tx.insert(treatmentTemplates).values({
      id: templateId,
      practiceId: fixture.practiceId,
      name: "Synthetic conversion version template",
      isActive: true,
    });
    await tx.insert(treatmentTemplateItems).values({
      id: randomUUID(),
      templateId,
      itemType: "service",
      itemId: fixture.serviceId,
      description: "Synthetic templated service",
      defaultQuantity: 1,
      defaultUnitPrice: "25.00",
      sortOrder: 0,
    });
  });
  return templateId;
}

async function cleanupFixture(practiceId: string): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx.execute(
      sql`select set_config('app.ledger_maintenance', 'on', true)`,
    );
    await tx
      .delete(visitWorkItems)
      .where(eq(visitWorkItems.practiceId, practiceId));
    await tx
      .delete(visitCloseouts)
      .where(eq(visitCloseouts.practiceId, practiceId));
    await tx
      .delete(dispenseChargeQueue)
      .where(eq(dispenseChargeQueue.practiceId, practiceId));
    await tx
      .delete(prescriptionEvents)
      .where(eq(prescriptionEvents.practiceId, practiceId));
    await tx
      .delete(invoiceItems)
      .where(
        inArray(
          invoiceItems.invoiceId,
          tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(eq(invoices.practiceId, practiceId)),
        ),
      );
    await tx
      .delete(treatmentTemplateItems)
      .where(
        inArray(
          treatmentTemplateItems.templateId,
          tx
            .select({ id: treatmentTemplates.id })
            .from(treatmentTemplates)
            .where(eq(treatmentTemplates.practiceId, practiceId)),
        ),
      );
    await tx
      .delete(treatmentTemplates)
      .where(eq(treatmentTemplates.practiceId, practiceId));
    await tx.delete(auditLog).where(eq(auditLog.practiceId, practiceId));
    await tx.delete(invoices).where(eq(invoices.practiceId, practiceId));
    await tx
      .delete(prescriptions)
      .where(eq(prescriptions.practiceId, practiceId));
    await tx.delete(products).where(eq(products.practiceId, practiceId));
    await tx.delete(services).where(eq(services.practiceId, practiceId));
    await tx
      .delete(appointments)
      .where(eq(appointments.practiceId, practiceId));
    await tx.delete(patients).where(eq(patients.practiceId, practiceId));
    await tx.delete(clients).where(eq(clients.practiceId, practiceId));
    await tx.delete(users).where(eq(users.practiceId, practiceId));
    await tx.delete(locations).where(eq(locations.practiceId, practiceId));
    await tx.delete(practices).where(eq(practices.id, practiceId));
  });
  fixtures.delete(practiceId);
}

async function invoiceState(practiceId: string) {
  return withSystem(db, async (tx) => {
    const rows = await tx
      .select({
        id: invoices.id,
        isEstimate: invoices.isEstimate,
        status: invoices.status,
      })
      .from(invoices)
      .where(eq(invoices.practiceId, practiceId))
      .orderBy(asc(invoices.id));
    const audits = await tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.practiceId, practiceId),
          eq(auditLog.action, "estimate_converted"),
        ),
      );
    return { rows, conversionAuditCount: audits.length };
  });
}

async function productStock(
  productIds: string[],
): Promise<Map<string, number>> {
  const rows = await withSystem(db, (tx) =>
    tx
      .select({ id: products.id, stockQuantity: products.stockQuantity })
      .from(products)
      .where(inArray(products.id, productIds)),
  );
  return new Map(rows.map((row) => [row.id, row.stockQuantity]));
}

describeWithPostgres("billing estimate conversion PostgreSQL drill", () => {
  beforeAll(() => {
    assertDisposableLocalDatabase();
  });

  afterEach(async () => {
    for (const practiceId of [...fixtures]) {
      await cleanupFixture(practiceId);
    }
  });

  it("serializes two estimates for one visit and deducts stock once", async () => {
    const fixture = await createFixture();
    const product = await createProduct(fixture, 10);
    const first = await createEstimate(fixture, {
      itemType: "product",
      itemId: product.id,
      quantity: 2,
    });
    const second = await createEstimate(fixture, {
      itemType: "product",
      itemId: product.id,
      quantity: 2,
    });

    const results = await within(
      Promise.allSettled([
        billingCaller(fixture).convertEstimateToInvoice({
          id: first.id,
          expectedUpdatedAt: first.updatedAt,
        }),
        billingCaller(fixture).convertEstimateToInvoice({
          id: second.id,
          expectedUpdatedAt: second.updatedAt,
        }),
      ]),
      "concurrent estimate conversion",
    );

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expectOneDomainRejection(results, [
      "This visit already has an active invoice. Open it instead of converting another estimate.",
    ]);
    const state = await invoiceState(fixture.practiceId);
    expect(state.rows.filter((row) => !row.isEstimate)).toHaveLength(1);
    expect(state.rows.filter((row) => row.isEstimate)).toHaveLength(1);
    expect(state.conversionAuditCount).toBe(1);
    expect((await productStock([product.id])).get(product.id)).toBe(8);
  });

  it("serializes conversion against creation of an actual visit invoice", async () => {
    const fixture = await createFixture();
    const product = await createProduct(fixture, 10);
    const estimate = await createEstimate(fixture, {
      itemType: "product",
      itemId: product.id,
      quantity: 2,
    });

    const results = await within(
      Promise.allSettled([
        billingCaller(fixture).convertEstimateToInvoice({
          id: estimate.id,
          expectedUpdatedAt: estimate.updatedAt,
        }),
        billingCaller(fixture).createInvoice({
          clientId: fixture.clientId,
          patientId: fixture.patientId,
          appointmentId: fixture.appointmentId,
          isEstimate: false,
          items: [
            {
              description: "Synthetic product",
              quantity: 2,
              unitPrice: "15.00",
              itemType: "product",
              itemId: product.id,
            },
          ],
        }),
      ]),
      "conversion/create serialization",
    );

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expectOneDomainRejection(results, [
      "This visit already has an active invoice. Open it instead of converting another estimate.",
      "This visit already has an active invoice. Open it instead of creating a duplicate.",
    ]);
    const state = await invoiceState(fixture.practiceId);
    expect(state.rows.filter((row) => !row.isEstimate)).toHaveLength(1);
    expect((await productStock([product.id])).get(product.id)).toBe(8);
  });

  it("makes an estimate confirmation stale after a serialized template edit", async () => {
    const fixture = await createFixture();
    const estimate = await createEstimate(fixture);
    const templateId = await createServiceTemplate(fixture);

    await expect(
      templatesCaller(fixture).applyToInvoice({
        templateId,
        invoiceId: estimate.id,
      }),
    ).resolves.toMatchObject({ id: estimate.id, isEstimate: true });
    await expect(
      billingCaller(fixture).convertEstimateToInvoice({
        id: estimate.id,
        expectedUpdatedAt: estimate.updatedAt,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("Estimate changed"),
    });

    const [current] = await withSystem(db, (tx) =>
      tx
        .select({
          isEstimate: invoices.isEstimate,
          updatedAt: invoices.updatedAt,
        })
        .from(invoices)
        .where(eq(invoices.id, estimate.id)),
    );
    const currentItems = await withSystem(db, (tx) =>
      tx
        .select({ id: invoiceItems.id })
        .from(invoiceItems)
        .where(eq(invoiceItems.invoiceId, estimate.id)),
    );
    expect(current).toMatchObject({ isEstimate: true });
    expect(current!.updatedAt.getTime()).toBeGreaterThan(
      estimate.updatedAt.getTime(),
    );
    expect(currentItems).toHaveLength(2);
  });

  it("rolls back an earlier stock deduction when a later product is insufficient", async () => {
    const fixture = await createFixture();
    const firstProduct = await createProduct(
      fixture,
      10,
      "10000000-0000-0000-0000-000000000001",
    );
    const secondProduct = await createProduct(
      fixture,
      0,
      "20000000-0000-0000-0000-000000000002",
    );
    const estimateId = randomUUID();
    const updatedAt = new Date();
    await withSystem(db, async (tx) => {
      await tx.insert(invoices).values({
        id: estimateId,
        practiceId: fixture.practiceId,
        clientId: fixture.clientId,
        patientId: fixture.patientId,
        appointmentId: fixture.appointmentId,
        status: "draft",
        subtotal: "30.00",
        tax: "0.00",
        total: "30.00",
        paidAmount: "0.00",
        isEstimate: true,
        updatedAt,
      });
      await tx.insert(invoiceItems).values([
        {
          id: "10000000-0000-0000-0000-000000000011",
          invoiceId: estimateId,
          description: "Synthetic available product",
          quantity: 1,
          unitPrice: "15.00",
          total: "15.00",
          taxable: true,
          itemType: "product",
          itemId: firstProduct.id,
        },
        {
          id: "20000000-0000-0000-0000-000000000022",
          invoiceId: estimateId,
          description: "Synthetic unavailable product",
          quantity: 1,
          unitPrice: "15.00",
          total: "15.00",
          taxable: true,
          itemType: "product",
          itemId: secondProduct.id,
        },
      ]);
    });

    await expect(
      billingCaller(fixture).convertEstimateToInvoice({
        id: estimateId,
        expectedUpdatedAt: updatedAt,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const stocks = await productStock([firstProduct.id, secondProduct.id]);
    expect(stocks.get(firstProduct.id)).toBe(10);
    expect(stocks.get(secondProduct.id)).toBe(0);
    const state = await invoiceState(fixture.practiceId);
    expect(state.rows).toEqual([
      { id: estimateId, isEstimate: true, status: "draft" },
    ]);
    expect(state.conversionAuditCount).toBe(0);
  });

  it("rejects a source-prescription estimate while its dispense remains pending", async () => {
    const fixture = await createFixture();
    const product = await createProduct(fixture, 10);
    const prescription = await createPrescription(fixture, product);
    const pendingId = await createPendingDispense(fixture, prescription);
    const estimate = await createEstimate(fixture, {
      itemType: "product",
      itemId: product.id,
      quantity: 2,
      sourcePrescriptionId: prescription.id,
    });

    await expect(
      billingCaller(fixture).convertEstimateToInvoice({
        id: estimate.id,
        expectedUpdatedAt: estimate.updatedAt,
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const [pending] = await withSystem(db, (tx) =>
      tx
        .select({ status: dispenseChargeQueue.status })
        .from(dispenseChargeQueue)
        .where(eq(dispenseChargeQueue.id, pendingId)),
    );
    expect(pending?.status).toBe("pending");
    expect((await productStock([product.id])).get(product.id)).toBe(10);
    const state = await invoiceState(fixture.practiceId);
    expect(state.rows[0]?.isEstimate).toBe(true);
    expect(state.conversionAuditCount).toBe(0);
  });

  it("serializes a same-visit medication estimate against its refill without deadlock", async () => {
    const fixture = await createFixture();
    const product = await createProduct(fixture, 10);
    const prescription = await createPrescription(fixture, product);
    const estimate = await createEstimate(fixture, {
      itemType: "product",
      itemId: product.id,
      quantity: 2,
    });

    const results = await within(
      Promise.allSettled([
        billingCaller(fixture).convertEstimateToInvoice({
          id: estimate.id,
          expectedUpdatedAt: estimate.updatedAt,
        }),
        recordsCaller(fixture).recordPrescriptionRefill({
          id: prescription.id,
          operationId: randomUUID(),
          appointmentId: fixture.appointmentId,
          note: "Synthetic concurrency drill refill",
        }),
      ]),
      "conversion/refill serialization",
    );

    assertNoDeadlock(results);
    expect(results[1]).toEqual(
      expect.objectContaining({ status: "fulfilled" }),
    );
    expect(results[0]).toEqual(expect.objectContaining({ status: "rejected" }));
    if (results[0]?.status === "rejected") {
      expect(results[0].reason).toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Charge a visit-dispensed medication from its prescription entry so stock is not deducted twice.",
      });
    }
    expect((await productStock([product.id])).get(product.id)).toBe(8);
    const [prescriptionState] = await withSystem(db, (tx) =>
      tx
        .select({ refillsRemaining: prescriptions.refillsRemaining })
        .from(prescriptions)
        .where(eq(prescriptions.id, prescription.id)),
    );
    expect(prescriptionState?.refillsRemaining).toBe(0);
    const queue = await withSystem(db, (tx) =>
      tx
        .select({ status: dispenseChargeQueue.status })
        .from(dispenseChargeQueue)
        .where(eq(dispenseChargeQueue.prescriptionId, prescription.id)),
    );
    expect(queue).toEqual([{ status: "pending" }]);
  });

  it("blocks visit financial handoff until an older prescription refill is charged", async () => {
    const fixture = await createFixture();
    const product = await createProduct(fixture, 10);
    const prescription = await createPrescription(fixture, product, null);
    const estimate = await createEstimate(fixture);

    await billingCaller(fixture).convertEstimateToInvoice({
      id: estimate.id,
      expectedUpdatedAt: estimate.updatedAt,
    });
    await recordsCaller(fixture).recordPrescriptionRefill({
      id: prescription.id,
      operationId: randomUUID(),
      appointmentId: fixture.appointmentId,
      note: "Synthetic visit-linked refill billing drill",
    });

    const closeoutBeforeFinalization = await encountersCaller(
      fixture,
    ).getCloseout({
      appointmentId: fixture.appointmentId,
    });
    expect(closeoutBeforeFinalization.activeMedications).toEqual([
      expect.objectContaining({
        id: prescription.id,
        productId: product.id,
        quantity: 2,
      }),
    ]);

    const clinicalInput = {
      appointmentId: fixture.appointmentId,
      expectedRevision: 0,
      diagnosisSummary: null,
      dischargeInstructions: null,
      warningSigns: null,
      noInstructionsReason: "Synthetic handoff has no owner instructions.",
      followUpDisposition: "none" as const,
      followUpNotes: null,
      followUpAppointmentId: null,
      followUpDueDate: null,
      followUpAssignedTo: null,
      documentationExceptionReason:
        "Synthetic drill does not require a SOAP note.",
    };
    await expect(
      encountersCaller(fixture).finalizeClinical({
        ...clinicalInput,
        prescriptionDisposition: "not_needed",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("linked prescriptions"),
    });
    const finalized = await encountersCaller(fixture).finalizeClinical({
      ...clinicalInput,
      prescriptionDisposition: "prescribed",
    });
    expect(finalized.medicationSnapshot).toEqual([
      expect.objectContaining({
        prescriptionId: prescription.id,
        quantity: 2,
      }),
    ]);

    await expect(
      billingCaller(fixture).updateInvoiceStatus({
        id: estimate.id,
        status: "sent",
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("medication dispense"),
    });

    const closeout = await encountersCaller(fixture).getCloseout({
      appointmentId: fixture.appointmentId,
    });
    const refillCharge = closeout.medications.find(
      (medication) =>
        medication.id === prescription.id &&
        medication.dispenseChargeStatus === "pending",
    );
    expect(refillCharge).toMatchObject({
      productId: product.id,
      dispenseChargeStatus: "pending",
      quantity: 2,
    });
    expect(refillCharge?.dispenseChargeId).toEqual(expect.any(String));

    await billingCaller(fixture).createDispenseChargeInvoice({
      id: refillCharge!.dispenseChargeId!,
      acknowledgeLegacyReview: false,
    });
    expect((await productStock([product.id])).get(product.id)).toBe(8);
    await expect(
      billingCaller(fixture).updateInvoiceStatus({
        id: estimate.id,
        status: "sent",
      }),
    ).resolves.toMatchObject({ id: estimate.id, status: "sent" });

    await expect(
      encountersCaller(fixture).completeVisit({
        appointmentId: fixture.appointmentId,
        expectedRevision: finalized.revision,
        chargeDisposition: "accounts_receivable",
        invoiceDueDate: "2099-12-31",
        handoffMethod: "print",
      }),
    ).resolves.toMatchObject({
      appointment: { status: "checked_out" },
      closeout: { status: "completed" },
    });
    const queue = await withSystem(db, (tx) =>
      tx
        .select({ status: dispenseChargeQueue.status })
        .from(dispenseChargeQueue)
        .where(eq(dispenseChargeQueue.id, refillCharge!.dispenseChargeId!)),
    );
    expect(queue).toEqual([{ status: "invoiced" }]);
  });

  it("serializes cross-invoice product swaps with the old and new stock rows prelocked", async () => {
    const fixture = await createFixture();
    const secondAppointmentId = await createVisit(fixture);
    const firstProduct = await createProduct(
      fixture,
      10,
      "10000000-0000-0000-0000-000000000101",
    );
    const secondProduct = await createProduct(
      fixture,
      10,
      "20000000-0000-0000-0000-000000000202",
    );
    const firstInvoice = await billingCaller(fixture).createInvoice({
      clientId: fixture.clientId,
      patientId: fixture.patientId,
      appointmentId: fixture.appointmentId,
      isEstimate: false,
      items: [
        {
          description: "Synthetic first product",
          quantity: 1,
          unitPrice: "15.00",
          itemType: "product",
          itemId: firstProduct.id,
        },
      ],
    });
    const secondInvoice = await billingCaller(fixture).createInvoice({
      clientId: fixture.clientId,
      patientId: fixture.patientId,
      appointmentId: secondAppointmentId,
      isEstimate: false,
      items: [
        {
          description: "Synthetic second product",
          quantity: 1,
          unitPrice: "15.00",
          itemType: "product",
          itemId: secondProduct.id,
        },
      ],
    });
    const invoiceVersions = await withSystem(db, (tx) =>
      tx
        .select({ id: invoices.id, updatedAt: invoices.updatedAt })
        .from(invoices)
        .where(inArray(invoices.id, [firstInvoice.id, secondInvoice.id])),
    );
    expect(
      new Map(invoiceVersions.map((invoice) => [invoice.id, invoice.updatedAt]))
        .get(firstInvoice.id)
        ?.getTime(),
    ).toBe(firstInvoice.updatedAt.getTime());
    expect(
      new Map(invoiceVersions.map((invoice) => [invoice.id, invoice.updatedAt]))
        .get(secondInvoice.id)
        ?.getTime(),
    ).toBe(secondInvoice.updatedAt.getTime());

    const results = await within(
      Promise.allSettled([
        billingCaller(fixture).updateInvoiceItems({
          id: firstInvoice.id,
          expectedUpdatedAt: firstInvoice.updatedAt,
          items: [
            {
              description: "Synthetic second product",
              quantity: 1,
              unitPrice: "15.00",
              itemType: "product",
              itemId: secondProduct.id,
            },
          ],
        }),
        billingCaller(fixture).updateInvoiceItems({
          id: secondInvoice.id,
          expectedUpdatedAt: secondInvoice.updatedAt,
          items: [
            {
              description: "Synthetic first product",
              quantity: 1,
              unitPrice: "15.00",
              itemType: "product",
              itemId: firstProduct.id,
            },
          ],
        }),
      ]),
      "cross-invoice product swap",
    );

    assertNoDeadlock(results);
    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    const stocks = await productStock([firstProduct.id, secondProduct.id]);
    expect(stocks.get(firstProduct.id)).toBe(9);
    expect(stocks.get(secondProduct.id)).toBe(9);
  });

  it("serializes a same-invoice product edit against void without a product-invoice deadlock", async () => {
    const fixture = await createFixture();
    const firstProduct = await createProduct(
      fixture,
      10,
      "10000000-0000-0000-0000-000000000301",
    );
    const secondProduct = await createProduct(
      fixture,
      10,
      "20000000-0000-0000-0000-000000000302",
    );
    const invoice = await billingCaller(fixture).createInvoice({
      clientId: fixture.clientId,
      patientId: fixture.patientId,
      isEstimate: false,
      items: [
        {
          description: "Synthetic first product",
          quantity: 1,
          unitPrice: "15.00",
          itemType: "product",
          itemId: firstProduct.id,
        },
      ],
    });

    const results = await within(
      Promise.allSettled([
        billingCaller(fixture).updateInvoiceItems({
          id: invoice.id,
          expectedUpdatedAt: invoice.updatedAt,
          items: [
            {
              description: "Synthetic second product",
              quantity: 1,
              unitPrice: "15.00",
              itemType: "product",
              itemId: secondProduct.id,
            },
          ],
        }),
        billingCaller(fixture).voidInvoice({
          id: invoice.id,
          reason: "Synthetic concurrency drill void",
        }),
      ]),
      "same-invoice edit/void serialization",
    );

    assertNoDeadlock(results);
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    if (results[0]?.status === "rejected") {
      expect(results[0].reason).toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Only an unpaid draft invoice can have its line items changed.",
      });
    }
    const [finalInvoice] = await withSystem(db, (tx) =>
      tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, invoice.id)),
    );
    expect(finalInvoice).toEqual({ status: "void" });
    const stocks = await productStock([firstProduct.id, secondProduct.id]);
    expect(stocks.get(firstProduct.id)).toBe(10);
    expect(stocks.get(secondProduct.id)).toBe(10);
  });
});
