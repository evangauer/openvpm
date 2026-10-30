import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import {
  exportPracticeData,
  restorePracticeData,
  validatePracticeExportRestore,
} from "@/lib/backup/export";
import { isApprovedRehearsalDatabase } from "../../../../test-support/rehearsal-database";

// Existing approved synthetic loopback database only. All source, collision,
// and restore rows roll back; no schema, role, credential, or provider changes.
// Owner-role tests cover row fidelity and rollback, not non-owner RLS or a
// recovery hold committed independently of the surrounding transaction.
const url = process.env.BACKUP_EXPORT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("backup financial row completeness", () => {
  let pg: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  type Backup = Awaited<ReturnType<typeof exportPracticeData>>;
  const legacyTables = {
    legacyFinancialDocuments: schema.legacyFinancialDocuments,
    legacyFinancialLineItems: schema.legacyFinancialLineItems,
    legacyFinancialPayments: schema.legacyFinancialPayments,
    legacyFinancialAllocations: schema.legacyFinancialAllocations,
  };
  type LegacySection = keyof typeof legacyTables;
  const legacySections = Object.keys(legacyTables) as LegacySection[];
  const rollbackFixture = new Error("rollback synthetic financial source");
  const rollbackDrill = new Error("rollback synthetic financial restore");
  const byId = (rows: unknown[]) => [...rows].sort((a, b) =>
    String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)),
  );

  beforeAll(async () => {
    const parsed = new URL(url!);
    const name = decodeURIComponent(parsed.pathname.slice(1));
    if (parsed.hostname !== "127.0.0.1" || !isApprovedRehearsalDatabase(name)) {
      throw new Error("An explicitly approved loopback rehearsal database is required");
    }
    pg = postgres(url!, { max: 1 });
    const [target] = await pg`
      select current_database() as name, host(inet_server_addr()) as host,
        (select pg_get_userbyid(datdba) = current_user
         from pg_database where datname = current_database()) as owned
    `;
    expect(target).toMatchObject({ name, host: "127.0.0.1", owned: true });
    db = drizzle(pg, { schema });
  });

  afterAll(async () => { await pg?.end(); });

  async function seedLegacyRows(
    tx: Tx,
    practiceId: string,
    clientId: string,
    collision?: { section: LegacySection; id: string },
  ) {
    const identity = (section: LegacySection, index: number) => ({
      id: collision?.section === section && index === 1 ? collision.id : randomUUID(),
      practiceId, externalSource: "synthetic",
      externalId: `synthetic-${randomUUID()}`,
      importFingerprint: randomBytes(32).toString("hex"),
      createdAt: new Date(`2026-10-27T1${index}:00:00.000Z`),
      updatedAt: new Date(`2026-10-28T1${index}:00:00.000Z`),
    });
    const documents = await tx.insert(schema.legacyFinancialDocuments).values(
      [0, 1].map((index) => ({
        ...identity("legacyFinancialDocuments", index), clientId,
        documentType: "invoice" as const, documentNumber: `SYNTHETIC-${index}`,
        issuedAt: new Date(`2026-10-27T1${index}:00:00.000Z`), dueDate: "2026-11-01",
        status: index === 0 ? "partial" as const : "open" as const,
        subtotal: index === 0 ? "10.00" : "20.00", tax: "0.00", discount: "0.00",
        total: index === 0 ? "10.00" : "20.00", paidAmount: index === 0 ? "2.00" : "0.00",
        balance: index === 0 ? "8.00" : "20.00", currency: "USD",
        sourceStatus: "Synthetic source status", note: `Synthetic imported invoice ${index}`,
      })),
    ).returning();
    const lineItems = await tx.insert(schema.legacyFinancialLineItems).values(
      documents.map((document, index) => ({
        ...identity("legacyFinancialLineItems", index), documentId: document.id,
        sortOrder: index, description: `Synthetic imported line ${index}`, quantity: "1.000",
        unitPrice: document.total, subtotal: document.subtotal, tax: document.tax,
        discount: document.discount, total: document.total,
      })),
    ).returning();
    const payments = await tx.insert(schema.legacyFinancialPayments).values(
      [0, 1].map((index) => ({
        ...identity("legacyFinancialPayments", index),
        clientId: index === 0 ? clientId : null,
        attributionStatus: index === 0 ? "matched" as const : "needs_review" as const,
        entryType: "payment" as const, amount: index === 0 ? "2.00" : "7.00",
        receivedAt: new Date(`2026-10-27T1${index}:30:00.000Z`), method: "Synthetic method",
        sourceStatus: "Synthetic source status", reference: `Synthetic reference ${index}`,
        note: index === 0 ? "Synthetic allocated payment" : "Synthetic unallocated payment",
      })),
    ).returning();
    const allocations = await tx.insert(schema.legacyFinancialAllocations).values(
      [0, 1].map((index) => ({
        ...identity("legacyFinancialAllocations", index), documentId: documents[0]!.id,
        paymentId: payments[0]!.id, amount: "1.00",
        allocatedAt: new Date(`2026-10-27T1${index}:45:00.000Z`),
        description: `Synthetic allocation ${index}`,
      })),
    ).returning();
    return {
      legacyFinancialDocuments: documents,
      legacyFinancialLineItems: lineItems,
      legacyFinancialPayments: payments,
      legacyFinancialAllocations: allocations,
    };
  }

  async function withFinancialBackup(
    check: (tx: Tx, practiceId: string, backup: Backup) => Promise<void>,
  ) {
    const practiceId = randomUUID();
    let completed = false;
    try {
      await db.transaction(async (tx) => {
        let backup: Backup | undefined;
        try {
          await tx.transaction(async (source) => {
            await source.insert(schema.practices).values({
              id: practiceId, name: "Synthetic financial source", timezone: "UTC",
            });
            await source.insert(schema.locations).values({
              practiceId, name: "Synthetic location", isPrimary: true,
            });
            const [staff] = await source.insert(schema.users).values({
              practiceId, name: "Synthetic staff", email: `${practiceId}@example.invalid`,
              role: "admin", passwordHash: "synthetic-not-a-login",
            }).returning();
            const [client] = await source.insert(schema.clients).values({
              practiceId, firstName: "Synthetic", lastName: "Owner",
            }).returning();
            const [service] = await source.insert(schema.services).values({
              practiceId, name: "Synthetic service", defaultPrice: "12.00",
            }).returning();
            const [invoice] = await source.insert(schema.invoices).values({
              practiceId, clientId: client!.id, status: "sent",
              subtotal: "12.00", tax: "0.00", total: "12.00", paidAmount: "4.00",
            }).returning();
            await source.insert(schema.invoiceItems).values({
              invoiceId: invoice!.id, itemType: "service", itemId: service!.id,
              description: service!.name, quantity: 1, unitPrice: "12.00", total: "12.00",
            });
            for (let index = 0; index < 2; index += 1) {
              const timestamp = new Date(`2026-10-28T1${index}:00:00.000Z`);
              await source.insert(schema.payments).values({
                invoiceId: invoice!.id, amount: index === 0 ? "1.00" : "3.00",
                method: index === 0 ? "cash" : "credit_card", receivedBy: staff!.id,
                externalId: `synthetic-payment-${randomUUID()}`,
                notes: `Synthetic payment ${index}`, receivedAt: timestamp,
                createdAt: timestamp, updatedAt: timestamp,
              });
              await source.insert(schema.invoiceAdjustments).values({
                invoiceId: invoice!.id, type: index === 0 ? "credit" : "write_off",
                amount: index === 0 ? "2.00" : "1.00", createdBy: staff!.id,
                reason: `Synthetic adjustment ${index}`, operationKey: `synthetic-adjustment-${randomUUID()}`,
                balanceAfter: index === 0 ? "6.00" : "5.00",
                createdAt: timestamp, updatedAt: timestamp,
              });
            }
            await seedLegacyRows(source, practiceId, client!.id);
            backup = JSON.parse(JSON.stringify(await exportPracticeData(
              source as never, practiceId, new Date().toISOString(),
            )));
            // Keep the unallocated row second for every payment collision,
            // independent of PostgreSQL's unspecified export row order.
            backup!.legacyFinancialPayments.sort((a, b) =>
              Number((a as { attributionStatus: string }).attributionStatus === "needs_review") -
              Number((b as { attributionStatus: string }).attributionStatus === "needs_review"),
            );
            throw rollbackFixture;
          });
        } catch (error) {
          if (error !== rollbackFixture) throw error;
        }
        expect(backup).toBeDefined();
        expect(backup!.payments).toHaveLength(2);
        expect(backup!.invoiceAdjustments).toHaveLength(2);
        for (const section of legacySections) expect(backup![section]).toHaveLength(2);
        expect(validatePracticeExportRestore(backup)).toEqual({ valid: true, errors: [] });
        await tx.insert(schema.practices).values({
          id: practiceId, name: "Synthetic financial target", timezone: "UTC",
        });
        await check(tx, practiceId, backup!);
        completed = true;
        throw rollbackDrill;
      });
    } catch (error) {
      if (error !== rollbackDrill) throw error;
    }
    expect(completed).toBe(true);
    expect(await db.select().from(schema.practices)
      .where(eq(schema.practices.id, practiceId))).toEqual([]);
  }

  it.each([false, true])("round-trips native and imported financial rows with reverse order %s", async (reverse) => {
    await withFinancialBackup(async (tx, practiceId, backup) => {
      if (reverse) {
        backup.payments.reverse();
        backup.invoiceAdjustments.reverse();
        for (const section of legacySections) backup[section].reverse();
      }
      const result = await restorePracticeData(tx as never, practiceId, backup, {
        recoveryHoldDb: tx as never,
      });
      expect(result.restored.payments).toBe(2);
      expect(result.restored.invoiceAdjustments).toBe(2);
      for (const section of legacySections) expect(result.restored[section]).toBe(2);
      const restored = JSON.parse(JSON.stringify(await exportPracticeData(
        tx as never, practiceId, new Date().toISOString(),
      ))) as Backup;
      for (const section of ["invoices", "invoiceItems", "payments", "invoiceAdjustments", ...legacySections] as const) {
        expect(byId(restored[section])).toEqual(byId(backup[section]));
      }
      const unallocated = (restored.legacyFinancialPayments as Record<string, unknown>[])
        .find((row) => row.attributionStatus === "needs_review")!;
      expect(unallocated).toMatchObject({ clientId: null, amount: "7.00" });
      expect((restored.legacyFinancialAllocations as Record<string, unknown>[])
        .some((row) => row.paymentId === unallocated.id)).toBe(false);
    });
  });

  const collisions = [
    { section: "payments", field: "id" },
    { section: "payments", field: "externalId" },
    { section: "invoiceAdjustments", field: "id" },
    { section: "invoiceAdjustments", field: "operationKey" },
  ] as const;
  it.each(collisions.flatMap((collision) => [
    { ...collision, scope: "foreign practice" },
    { ...collision, scope: "backup" },
  ]))("rolls back a $section $field collision in $scope", async ({ section, field, scope }) => {
    await withFinancialBackup(async (tx, practiceId, backup) => {
      const rows = backup[section] as Record<string, unknown>[];
      let foreignInvoice: typeof schema.invoices.$inferSelect | undefined;
      let foreignPayment: typeof schema.payments.$inferSelect | undefined;
      let foreignAdjustment: typeof schema.invoiceAdjustments.$inferSelect | undefined;
      if (scope === "backup") {
        // The first row inserts, then the second conflicts. No partial ledger
        // or earlier restored clinic rows may survive the restore transaction.
        rows[1]![field] = rows[0]![field];
      } else {
        const [foreign] = await tx.insert(schema.practices).values({
          name: "Unrelated synthetic financial clinic",
        }).returning();
        const [foreignClient] = await tx.insert(schema.clients).values({
          practiceId: foreign!.id, firstName: "Unrelated", lastName: "Synthetic owner",
        }).returning();
        [foreignInvoice] = await tx.insert(schema.invoices).values({
          practiceId: foreign!.id, clientId: foreignClient!.id, total: "99.00",
        }).returning();
        [foreignPayment] = await tx.insert(schema.payments).values({
          invoiceId: foreignInvoice!.id, amount: "99.00", method: "other",
          id: section === "payments" && field === "id" ? String(rows[1]!.id) : randomUUID(),
          externalId: section === "payments" && field === "externalId"
            ? String(rows[1]!.externalId) : `unrelated-${randomUUID()}`,
        }).returning();
        [foreignAdjustment] = await tx.insert(schema.invoiceAdjustments).values({
          invoiceId: foreignInvoice!.id, amount: "9.00", type: "credit",
          id: section === "invoiceAdjustments" && field === "id" ? String(rows[1]!.id) : randomUUID(),
          operationKey: section === "invoiceAdjustments" && field === "operationKey"
            ? String(rows[1]!.operationKey) : `unrelated-${randomUUID()}`,
          balanceAfter: "90.00",
        }).returning();
      }
      expect(validatePracticeExportRestore(backup)).toEqual({ valid: true, errors: [] });
      await expect(restorePracticeData(tx as never, practiceId, backup, {
        recoveryHoldDb: tx as never,
      })).rejects.toThrow(`${section} restore did not insert every expected row.`);
      expect(await tx.select().from(schema.clients)
        .where(eq(schema.clients.practiceId, practiceId))).toEqual([]);
      expect(await tx.select().from(schema.invoices)
        .where(eq(schema.invoices.practiceId, practiceId))).toEqual([]);
      const invoiceId = String((backup.invoices[0] as { id: string }).id);
      expect(await tx.select().from(schema.invoiceItems)
        .where(eq(schema.invoiceItems.invoiceId, invoiceId))).toEqual([]);
      expect(await tx.select().from(schema.payments)
        .where(eq(schema.payments.invoiceId, invoiceId))).toEqual([]);
      expect(await tx.select().from(schema.invoiceAdjustments)
        .where(eq(schema.invoiceAdjustments.invoiceId, invoiceId))).toEqual([]);
      if (foreignInvoice) {
        expect(await tx.select().from(schema.invoices)
          .where(eq(schema.invoices.id, foreignInvoice.id))).toEqual([foreignInvoice]);
        expect(await tx.select().from(schema.payments)
          .where(eq(schema.payments.invoiceId, foreignInvoice.id))).toEqual([foreignPayment]);
        expect(await tx.select().from(schema.invoiceAdjustments)
          .where(eq(schema.invoiceAdjustments.invoiceId, foreignInvoice.id))).toEqual([foreignAdjustment]);
      }
    });
  });

  const legacyCollisions = legacySections.flatMap((section) => [
    { section, field: "id", scope: "foreign practice" },
    { section, field: "id", scope: "backup" },
    { section, field: "externalId", scope: "backup" },
    { section, field: "importFingerprint", scope: "backup" },
  ]);
  it.each(legacyCollisions)("rolls back a $section $field collision in $scope", async ({ section, field, scope }) => {
    await withFinancialBackup(async (tx, practiceId, backup) => {
      const rows = backup[section] as Record<string, unknown>[];
      if (section === "legacyFinancialPayments") {
        expect(rows[1]).toMatchObject({ attributionStatus: "needs_review", clientId: null });
        expect((backup.legacyFinancialAllocations as Record<string, unknown>[])
          .some((row) => row.paymentId === rows[1]!.id)).toBe(false);
      }
      let foreignRows: Awaited<ReturnType<typeof seedLegacyRows>> | undefined;
      if (scope === "backup") {
        rows[1]![field] = rows[0]![field];
      } else {
        const [foreign] = await tx.insert(schema.practices).values({
          name: "Unrelated synthetic imported ledger",
        }).returning();
        const [client] = await tx.insert(schema.clients).values({
          practiceId: foreign!.id, firstName: "Unrelated", lastName: "Synthetic owner",
        }).returning();
        foreignRows = await seedLegacyRows(tx, foreign!.id, client!.id, {
          section, id: String(rows[1]!.id),
        });
      }
      expect(validatePracticeExportRestore(backup)).toEqual({ valid: true, errors: [] });
      await expect(restorePracticeData(tx as never, practiceId, backup, {
        recoveryHoldDb: tx as never,
      })).rejects.toThrow(`${section} restore did not insert every expected row.`);
      for (const key of legacySections) {
        const table = legacyTables[key];
        expect(await tx.select().from(table).where(eq(table.practiceId, practiceId))).toEqual([]);
        if (foreignRows) {
          const foreignPracticeId = foreignRows[key][0]!.practiceId;
          expect(byId(await tx.select().from(table).where(eq(table.practiceId, foreignPracticeId))))
            .toEqual(byId(foreignRows[key]));
        }
      }
      expect(await tx.select().from(schema.clients)
        .where(eq(schema.clients.practiceId, practiceId))).toEqual([]);
      expect(await tx.select().from(schema.invoices)
        .where(eq(schema.invoices.practiceId, practiceId))).toEqual([]);
      const invoiceId = String((backup.invoices[0] as { id: string }).id);
      expect(await tx.select().from(schema.payments)
        .where(eq(schema.payments.invoiceId, invoiceId))).toEqual([]);
      expect(await tx.select().from(schema.invoiceAdjustments)
        .where(eq(schema.invoiceAdjustments.invoiceId, invoiceId))).toEqual([]);
    });
  });
});
