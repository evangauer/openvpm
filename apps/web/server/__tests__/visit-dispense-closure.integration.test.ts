import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { withTenant } from "@/lib/tenant-db";
import {
  assertNoUnresolvedVisitWork,
  assertVisitInvoiceReadyForFinancialAction,
} from "../visit-billing-integrity";

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: vi.fn(async () => undefined),
}));

const repoRoot = resolve(process.cwd(), "../..");
const describeWithPostgres =
  process.env.VISIT_DISPENSE_DB_INTEGRATION === "1"
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

describeWithPostgres(
  "visit-linked dispense closure PostgreSQL contract",
  () => {
    it("surfaces and blocks an older-prescription refill until it is resolved", async () => {
      const adminUrl = process.env.DATABASE_URL?.trim();
      if (!adminUrl) throw new Error("DATABASE_URL is required");
      const hostname = new URL(adminUrl).hostname;
      if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
        throw new Error(
          "This drill is restricted to disposable local PostgreSQL",
        );
      }
      if (!process.env.OPENPIMS_APP_DB_PASSWORD?.trim()) {
        throw new Error("OPENPIMS_APP_DB_PASSWORD is required");
      }

      const databaseName = `openpims_visit_dispense_${randomUUID().replaceAll("-", "")}`;
      if (!/^openpims_visit_dispense_[a-f0-9]+$/.test(databaseName)) {
        throw new Error("unsafe disposable database name");
      }
      const databaseUrl = new URL(adminUrl);
      databaseUrl.pathname = `/${databaseName}`;
      databaseUrl.search = "";
      databaseUrl.hash = "";

      const adminSql = postgres(adminUrl, { max: 1 });
      let ownerSql: ReturnType<typeof postgres> | undefined;
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
        const ownerDb = drizzle(ownerSql, { schema });
        const practiceId = randomUUID();
        const userId = randomUUID();
        const locationId = randomUUID();
        const clientId = randomUUID();
        const patientId = randomUUID();
        const appointmentId = randomUUID();
        const productId = randomUUID();
        const invoiceId = randomUUID();
        const prescriptionId = randomUUID();
        const eventId = randomUUID();

        await ownerDb.insert(schema.practices).values({
          id: practiceId,
          name: "Synthetic visit-dispense clinic",
          timezone: "UTC",
        });
        await ownerDb.insert(schema.users).values({
          id: userId,
          practiceId,
          email: `visit-dispense-${userId}@example.invalid`,
          passwordHash: "synthetic-not-a-login",
          name: "Synthetic veterinarian",
          role: "admin",
          isVeterinarian: true,
        });
        await ownerDb.insert(schema.locations).values({
          id: locationId,
          practiceId,
          name: "Synthetic location",
          isPrimary: true,
        });
        await ownerDb.insert(schema.clients).values({
          id: clientId,
          practiceId,
          firstName: "Synthetic",
          lastName: "Client",
        });
        await ownerDb.insert(schema.patients).values({
          id: patientId,
          practiceId,
          clientId,
          name: "Synthetic Patient",
          species: "canine",
        });
        await ownerDb.insert(schema.appointments).values({
          id: appointmentId,
          practiceId,
          locationId,
          startTime: new Date("2026-08-25T14:00:00.000Z"),
          endTime: new Date("2026-08-25T15:00:00.000Z"),
          patientId,
          clientId,
          doctorId: userId,
          status: "in_exam",
        });
        await ownerDb.insert(schema.products).values({
          id: productId,
          practiceId,
          locationId,
          name: "Synthetic tracked medication",
          unitPrice: "15.00",
          taxable: true,
          inventoryTracked: true,
          stockQuantity: 10,
        });
        await ownerDb.insert(schema.invoices).values({
          id: invoiceId,
          practiceId,
          clientId,
          patientId,
          appointmentId,
          status: "draft",
          subtotal: "25.00",
          tax: "0.00",
          total: "25.00",
          paidAmount: "0.00",
          isEstimate: false,
        });
        await ownerDb.insert(schema.invoiceItems).values({
          invoiceId,
          description: "Synthetic visit charge",
          quantity: 1,
          unitPrice: "25.00",
          total: "25.00",
          taxable: false,
          itemType: "product",
          itemId: productId,
        });
        // This prescription predates the visit; only its refill dispense is
        // linked to the current appointment.
        await ownerDb.insert(schema.prescriptions).values({
          id: prescriptionId,
          practiceId,
          patientId,
          appointmentId: null,
          medicationName: "Synthetic medication",
          dosage: "25 mg",
          frequency: "Once daily",
          quantity: 2,
          productId,
          refillsRemaining: 1,
          prescribedBy: userId,
          startDate: "2026-08-01",
          status: "active",
        });
        await ownerDb.insert(schema.prescriptionEvents).values({
          id: eventId,
          practiceId,
          prescriptionId,
          patientId,
          productId,
          eventType: "created",
          quantity: 2,
          statusBefore: null,
          statusAfter: "active",
          refillsBefore: null,
          refillsAfter: 1,
          reason: null,
          actorId: userId,
          actorName: "Synthetic veterinarian",
        });

        process.env.DATABASE_URL = databaseUrl.toString();
        const [{ encountersRouter }, { billingRouter }, { recordsRouter }] =
          await Promise.all([
            import("../routers/encounters"),
            import("../routers/billing"),
            import("../routers/records"),
          ]);
        const callerContext = {
          db: ownerDb,
          session: {
            user: {
              id: userId,
              email: `visit-dispense-${userId}@example.invalid`,
              name: "Synthetic veterinarian",
              role: "admin",
              practiceId,
            },
          },
        } as never;
        const caller = encountersRouter.createCaller(callerContext);
        const billingCaller = billingRouter.createCaller(callerContext);
        const recordsCaller = recordsRouter.createCaller(callerContext);

        await ownerSql`set role openpims_app`;
        await expect(
          recordsCaller.recordPrescriptionRefill({
            id: prescriptionId,
            operationId: randomUUID(),
            appointmentId,
            note: "Synthetic closure drill",
          }),
        ).resolves.toMatchObject({
          replayed: false,
          prescription: { refillsRemaining: 0 },
          event: { eventType: "refill_dispensed" },
        });
        const [createdQueue] = await withTenant(ownerDb, practiceId, (tx) =>
          tx
            .select({
              id: schema.dispenseChargeQueue.id,
              status: schema.dispenseChargeQueue.status,
            })
            .from(schema.dispenseChargeQueue)
            .where(eq(schema.dispenseChargeQueue.appointmentId, appointmentId)),
        );
        expect(createdQueue?.status).toBe("pending");
        const queueId = createdQueue?.id;
        if (!queueId)
          throw new Error("refill did not create a dispense charge");
        const [stockAfterRefill] = await withTenant(ownerDb, practiceId, (tx) =>
          tx
            .select({ stockQuantity: schema.products.stockQuantity })
            .from(schema.products)
            .where(eq(schema.products.id, productId)),
        );
        expect(stockAfterRefill?.stockQuantity).toBe(8);

        await ownerSql`reset role`;
        await ownerDb.insert(schema.visitCloseouts).values({
          practiceId,
          appointmentId,
          status: "clinical_finalized",
          prescriptionDisposition: "prescribed",
          medicationSnapshot: [
            {
              prescriptionId,
              medicationName: "Synthetic medication",
              dosage: "25 mg",
              frequency: "Once daily",
              instructions: null,
              quantity: 2,
            },
          ],
          noInstructionsReason: "Synthetic drill has no owner instructions.",
          followUpDisposition: "none",
          documentationExceptionReason: "Synthetic closure drill.",
          clinicalFinalizedAt: new Date(),
          clinicalFinalizedBy: userId,
          clinicalFinalizerName: "Synthetic veterinarian",
          revision: 1,
        });

        await ownerSql`set role openpims_app`;
        const [withoutTenantContext] = await ownerSql<
          Array<{ count: number }>
        >`select count(*)::int as count from dispense_charge_queue`;
        expect(withoutTenantContext?.count).toBe(0);

        const closeout = await caller.getCloseout({ appointmentId });
        expect(closeout.medications).toEqual([
          expect.objectContaining({
            id: prescriptionId,
            dispenseChargeId: queueId,
            dispenseChargeStatus: "pending",
            productId,
            quantity: 2,
          }),
        ]);
        expect(closeout.activeMedications).toEqual([
          expect.objectContaining({
            id: prescriptionId,
            dispenseChargeId: queueId,
          }),
        ]);

        await expect(
          caller.completeVisit({
            appointmentId,
            expectedRevision: 1,
            chargeDisposition: "no_charge",
            noChargeReason: "Synthetic no-charge checkout",
            handoffMethod: "print",
          }),
        ).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          message: expect.stringContaining("medication dispense"),
        });
        await expect(
          billingCaller.updateInvoiceStatus({ id: invoiceId, status: "sent" }),
        ).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          message: expect.stringContaining("medication dispense"),
        });
        await expect(
          withTenant(ownerDb, practiceId, (tx) =>
            assertVisitInvoiceReadyForFinancialAction(
              { db: tx, practiceId },
              appointmentId,
            ),
          ),
        ).rejects.toMatchObject({
          code: "PRECONDITION_FAILED",
          message: expect.stringContaining("medication dispense"),
        });
        const stillOpen = await withTenant(ownerDb, practiceId, (tx) =>
          tx
            .select({ status: schema.appointments.status })
            .from(schema.appointments)
            .where(eq(schema.appointments.id, appointmentId)),
        );
        expect(stillOpen).toEqual([{ status: "in_exam" }]);

        await ownerSql`reset role`;
        await ownerDb
          .update(schema.dispenseChargeQueue)
          .set({
            status: "waived",
            resolvedBy: userId,
            resolvedByName: "Synthetic veterinarian",
            resolvedAt: new Date(),
            resolutionReason: "Synthetic no-charge resolution",
          })
          .where(eq(schema.dispenseChargeQueue.id, queueId));
        await ownerSql`set role openpims_app`;

        await expect(
          withTenant(ownerDb, practiceId, (tx) =>
            assertNoUnresolvedVisitWork({ db: tx, practiceId }, appointmentId),
          ),
        ).resolves.toBeUndefined();
        await expect(
          withTenant(ownerDb, practiceId, (tx) =>
            assertVisitInvoiceReadyForFinancialAction(
              { db: tx, practiceId },
              appointmentId,
            ),
          ),
        ).resolves.toBeUndefined();
      } finally {
        process.env.DATABASE_URL = adminUrl;
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
  },
);
