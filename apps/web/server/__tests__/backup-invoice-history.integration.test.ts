import { randomUUID } from "node:crypto";
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

// Uses an existing, explicitly approved synthetic loopback database only.
// No database, role, credential, migration, RLS, or provider changes. Every
// fixture and restore is rolled back. This owner-role suite tests PostgreSQL
// invariants and restore fidelity, not RLS or independently committed holds.
const url = process.env.BACKUP_EXPORT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("backup of retained dispense invoice history", () => {
  let pg: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const rollbackFixture = new Error("rollback synthetic source fixture");
  const rollbackDrill = new Error("rollback synthetic restore drill");
  const rollbackCollision = new Error("rollback synthetic collision fixture");

  beforeAll(async () => {
    const parsed = new URL(url!);
    const name = decodeURIComponent(parsed.pathname.slice(1));
    if (
      parsed.hostname !== "127.0.0.1" ||
      !isApprovedRehearsalDatabase(name)
    ) throw new Error("An explicitly approved loopback rehearsal database is required");
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

  const cases = [
    { name: "multiple void invoices", status: "waived", historicalEstimate: false, history: 2, emptyActive: false },
    { name: "void plus empty active invoice", status: "waived", historicalEstimate: false, history: 1, emptyActive: true },
    { name: "reissued active charge", status: "invoiced", historicalEstimate: false, history: 2, emptyActive: false },
    { name: "estimate plus empty active invoice", status: "waived", historicalEstimate: true, history: 1, emptyActive: true },
    { name: "pending charge", status: "pending", historicalEstimate: false, history: 1, emptyActive: false },
  ] as const;
  it.each(cases.flatMap((scenario) => [
    { ...scenario, reverse: false }, { ...scenario, reverse: true },
  ]))(
    "$name round-trips one appointment with reverse order $reverse",
    async ({ status, historicalEstimate, history, emptyActive, reverse }) => {
      const practiceId = randomUUID();
      let completed = false;
      try {
        await db.transaction(async (tx) => {
          let backup: Awaited<ReturnType<typeof exportPracticeData>> | undefined;
          try {
            await tx.transaction(async (source) => {
              await source.insert(schema.practices).values({
                id: practiceId, name: "Synthetic invoice-history clinic", timezone: "UTC",
              });
              const [location] = await source.insert(schema.locations).values({
                practiceId, name: "Synthetic location", isPrimary: true,
              }).returning();
              const [staff] = await source.insert(schema.users).values({
                practiceId, name: "Synthetic staff", email: `${practiceId}@example.invalid`,
                role: "admin", passwordHash: "synthetic-not-a-login",
              }).returning();
              const [client] = await source.insert(schema.clients).values({
                practiceId, firstName: "Synthetic", lastName: "Owner",
              }).returning();
              const [patient] = await source.insert(schema.patients).values({
                practiceId, clientId: client!.id, name: "Synthetic patient", species: "canine",
              }).returning();
              const [appointment] = await source.insert(schema.appointments).values({
                practiceId, locationId: location!.id, patientId: patient!.id,
                clientId: client!.id, doctorId: staff!.id, status: "in_exam",
                startTime: new Date("2026-10-29T10:00:00Z"),
                endTime: new Date("2026-10-29T10:30:00Z"),
              }).returning();
              const [product] = await source.insert(schema.products).values({
                practiceId, name: "Synthetic medication", unitPrice: "12.00", stockQuantity: 0,
              }).returning();
              const [prescription] = await source.insert(schema.prescriptions).values({
                practiceId, patientId: patient!.id, appointmentId: appointment!.id,
                productId: product!.id, quantity: 1,
                medicationName: product!.name, dosage: "Synthetic", frequency: "Synthetic",
                prescribedBy: staff!.id, startDate: "2026-10-29",
              }).returning();
              const [event] = await source.insert(schema.prescriptionEvents).values({
                practiceId, prescriptionId: prescription!.id, patientId: patient!.id,
                productId: product!.id, eventType: "created", quantity: 1,
                actorId: staff!.id, actorName: staff!.name, statusAfter: "active", refillsAfter: 0,
              }).returning();
              const [charge] = await source.insert(schema.dispenseChargeQueue).values({
                practiceId, prescriptionEventId: event!.id, prescriptionId: prescription!.id,
                patientId: patient!.id, clientId: client!.id, appointmentId: appointment!.id,
                productId: product!.id,
                quantity: 1, descriptionSnapshot: product!.name, unitPriceSnapshot: "12.00",
              }).returning();
              const invoice = async () => {
                const [row] = await source.insert(schema.invoices).values({
                  practiceId, clientId: client!.id, patientId: patient!.id,
                  appointmentId: appointment!.id,
                  status: "draft", subtotal: "12.00", tax: "0.00", total: "12.00",
                }).returning();
                const [item] = await source.insert(schema.invoiceItems).values({
                  invoiceId: row!.id, itemType: "product", itemId: product!.id,
                  description: product!.name, quantity: 1, unitPrice: "12.00", total: "12.00",
                  sourceDispenseChargeId: charge!.id,
                }).returning();
                await source.update(schema.dispenseChargeQueue).set({
                  status: "invoiced", invoiceId: row!.id, invoiceItemId: item!.id,
                  resolvedBy: staff!.id, resolvedByName: staff!.name, resolvedAt: new Date(),
                }).where(eq(schema.dispenseChargeQueue.id, charge!.id));
                return row!;
              };
              let historicalId: string | undefined;
              for (let index = 0; index < history; index += 1) {
                const historical = await invoice();
                historicalId = historical.id;
                // Real triggers retain each invoice line and reopen its charge.
                await source.update(schema.invoices).set({ status: "void" })
                  .where(eq(schema.invoices.id, historical.id));
              }
              if (historicalEstimate) {
                await source.update(schema.invoices).set({ status: "draft", isEstimate: true })
                  .where(eq(schema.invoices.id, historicalId!));
              }
              if (status === "waived") {
                await source.update(schema.dispenseChargeQueue).set({
                  status, resolvedBy: staff!.id, resolvedByName: staff!.name,
                  resolvedAt: new Date(), resolutionReason: "Synthetic waiver after void",
                }).where(eq(schema.dispenseChargeQueue.id, charge!.id));
              } else if (status === "invoiced") {
                await invoice();
              }
              if (emptyActive) {
                await source.insert(schema.invoices).values({
                  practiceId, clientId: client!.id, patientId: patient!.id,
                  appointmentId: appointment!.id, status: "draft",
                });
              }
              backup = JSON.parse(JSON.stringify(await exportPracticeData(
                source as never, practiceId, new Date().toISOString(),
              )));
              // Put the historical rows first deterministically, then exercise
              // the reverse order too. PostgreSQL export order is unspecified.
              const active = (row: unknown) => {
                const invoice = row as { status: string; isEstimate: boolean };
                return Number(invoice.status !== "void" && invoice.isEstimate !== true);
              };
              backup!.invoices.sort((a, b) => active(a) - active(b));
              if (reverse) {
                backup!.invoices.reverse();
                backup!.invoiceItems.reverse();
              }
              throw rollbackFixture;
            });
          } catch (error) {
            if (error !== rollbackFixture) throw error;
          }
          expect(backup).toBeDefined();
          expect(validatePracticeExportRestore(backup)).toEqual({ valid: true, errors: [] });
          // The source savepoint was rolled back; restore the same UUIDs into
          // an empty synthetic shell without copying or deleting existing data.
          await tx.insert(schema.practices).values({
            id: practiceId, name: "Synthetic restore target", timezone: "UTC",
          });
          // An ID collision must fail before touching another practice's row,
          // even when ON CONFLICT would otherwise silently skip that invoice.
          try {
            await tx.transaction(async (collision) => {
              const [foreign] = await collision.insert(schema.practices)
                .values({ name: "Unrelated synthetic collision clinic" }).returning();
              const [foreignClient] = await collision.insert(schema.clients).values({
                practiceId: foreign!.id, firstName: "Unrelated", lastName: "Synthetic owner",
              }).returning();
              const invoiceId = (backup!.invoices[0] as { id: string }).id;
              const [foreignInvoice] = await collision.insert(schema.invoices).values({
                id: invoiceId, practiceId: foreign!.id, clientId: foreignClient!.id,
              }).returning();
              await expect(restorePracticeData(collision as never, practiceId, backup, {
                recoveryHoldDb: collision as never,
              })).rejects.toThrow("invoices restore did not insert every expected row");
              expect(await collision.select().from(schema.invoices)
                .where(eq(schema.invoices.practiceId, practiceId))).toEqual([]);
              expect(await collision.select().from(schema.invoices)
                .where(eq(schema.invoices.id, invoiceId))).toEqual([foreignInvoice]);
              throw rollbackCollision;
            });
          } catch (error) {
            if (error !== rollbackCollision) throw error;
          }

          const duplicateActive = structuredClone(backup!);
          const isActive = (value: unknown) => {
            const row = value as { status: string; isEstimate: boolean };
            return row.status !== "void" && row.isEstimate !== true;
          };
          const extra = duplicateActive.invoices.some(isActive) ? 1 : 2;
          for (let index = 0; index < extra; index += 1) {
            duplicateActive.invoices.push({
              ...(duplicateActive.invoices[0] as Record<string, unknown>),
              id: randomUUID(), status: "draft", isEstimate: false,
            });
          }
          duplicateActive.counts.invoices = duplicateActive.invoices.length;
          expect(validatePracticeExportRestore(duplicateActive).valid).toBe(true);
          await expect(restorePracticeData(tx as never, practiceId, duplicateActive, {
            recoveryHoldDb: tx as never,
          })).rejects.toMatchObject({ cause: { code: "23505" } });
          expect(await tx.select().from(schema.invoices)
            .where(eq(schema.invoices.practiceId, practiceId))).toEqual([]);

          const invalid = structuredClone(backup!);
          Object.assign(invalid.invoiceItems[0]!, { description: "Tampered synthetic line" });
          await expect(restorePracticeData(tx as never, practiceId, invalid, {
            recoveryHoldDb: tx as never,
          })).rejects.toMatchObject({ cause: { message: "invalid medication dispense invoice line" } });
          expect(await tx.select().from(schema.invoices)
            .where(eq(schema.invoices.practiceId, practiceId))).toEqual([]);
          expect(await tx.select().from(schema.dispenseChargeQueue)
            .where(eq(schema.dispenseChargeQueue.practiceId, practiceId))).toEqual([]);
          const result = await restorePracticeData(tx as never, practiceId, backup, { recoveryHoldDb: tx as never });
          expect(result.restored.invoices).toBe(backup!.invoices.length);
          expect(result.restored.invoiceItems).toBe(backup!.invoiceItems.length);
          expect(result.restored.dispenseChargeQueue).toBe(backup!.dispenseChargeQueue.length);
          const restored = JSON.parse(JSON.stringify(await exportPracticeData(
            tx as never, practiceId, new Date().toISOString(),
          ))) as NonNullable<typeof backup>;
          const byId = (rows: unknown[]) => [...rows].sort((a, b) =>
            String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)),
          );
          expect(byId(restored.invoices)).toEqual(byId(backup!.invoices));
          expect(byId(restored.invoiceItems)).toEqual(byId(backup!.invoiceItems));
          expect(byId(restored.dispenseChargeQueue)).toEqual(byId(backup!.dispenseChargeQueue));
          expect(byId(restored.appointments)).toEqual(byId(backup!.appointments));
          expect(restored.dispenseChargeQueue[0]).toMatchObject({ status });
          const [held] = await tx.select().from(schema.practices)
            .where(eq(schema.practices.id, practiceId));
          expect(held?.recoveryHold).toBe(true);
          completed = true;
          throw rollbackDrill;
        });
      } catch (error) {
        if (error !== rollbackDrill) throw error;
      }
      expect(completed).toBe(true);
      expect(await db.select().from(schema.practices)
        .where(eq(schema.practices.id, practiceId))).toEqual([]);
    }, 60_000,
  );
});
