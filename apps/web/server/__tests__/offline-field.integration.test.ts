import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../../../packages/db/schema/index";
import { createRouter, type TRPCContext } from "../trpc";
import { offlineFieldRouter } from "../routers/offline-field";
import { disposableClinic } from "./helpers/disposable-clinic";
import { exportPracticeData } from "@/lib/backup/export";
import { EMPTY_SOAP } from "@/lib/offline/workspace";
import type { FieldSubmission } from "@/lib/offline/field";

const integration =
  process.env.OFFLINE_WORKSPACE_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;
integration("offline field clinic isolation and replay", () => {
  it("requires a live clinician owner, rejects altered preparation and converges concurrent retries to one visit", async () => {
    const fixture = await disposableClinic(),
      originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = fixture.appUrl;
    vi.stubEnv("OFFLINE_FIELD_VISITS_ENABLED", "true");
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
    try {
      const db = fixture.ownerDb;
      const [practice, otherPractice] = await db
        .insert(schema.practices)
        .values(
          ["Primary", "Other"].map((name) => ({
            name: `Synthetic ${name}`,
            country: "US",
            currency: "usd",
            taxRatePercent: "0.00",
            settings: { ambulatoryWorkspace: { enabled: true } },
          })),
        )
        .returning();
      const [doctor, otherDoctor] = await db
        .insert(schema.users)
        .values(
          [practice!, otherPractice!].map((p) => ({
            practiceId: p.id,
            name: "Synthetic clinician",
            email: `${randomUUID()}@example.invalid`,
            passwordHash: "synthetic",
            role: "admin" as const,
            isVeterinarian: true,
          })),
        )
        .returning();
      const [client, otherClient] = await db
        .insert(schema.clients)
        .values(
          [practice!, otherPractice!].map((p) => ({
            practiceId: p.id,
            firstName: "Synthetic",
            lastName: "Owner",
          })),
        )
        .returning();
      const [patient, otherPatient] = await db
        .insert(schema.patients)
        .values(
          [client!, otherClient!].map((c) => ({
            practiceId: c.practiceId,
            clientId: c.id,
            name: "Synthetic Patient",
            species: "feline" as const,
          })),
        )
        .returning();
      await db
        .insert(schema.locations)
        .values(
          [practice!, otherPractice!].map((p) => ({
            practiceId: p.id,
            name: "Synthetic Location",
            isPrimary: true,
          })),
        );
      const [service] = await db
        .insert(schema.services)
        .values({
          practiceId: practice!.id,
          name: "Synthetic service",
          defaultPrice: "20.00",
          taxable: false,
        })
        .returning();
      const router = createRouter({ offlineField: offlineFieldRouter });
      const caller = (actor = doctor!) =>
        router.createCaller({
          db: fixture.db,
          session: {
            expires: "2099-01-01",
            user: {
              id: actor.id,
              practiceId: actor.practiceId,
              name: actor.name,
              email: actor.email,
              role: actor.role,
            },
          },
        } as TRPCContext).offlineField;
      await expect(
        caller().prepare({ patientId: otherPatient!.id }),
      ).rejects.toThrow();
      const packet = await caller().prepare({ patientId: patient!.id });
      const input: FieldSubmission = {
        packet,
        visit: {
          startedAt: packet.preparedAt,
          issuedAt: new Date().toISOString(),
          sections: { ...EMPTY_SOAP, subjective: "Synthetic field note" },
          charges: [{ serviceId: service!.id, quantity: 1 }],
          vaccinations: [],
          payment: {
            method: "check",
            amount: "10.00",
            receivedAt: packet.preparedAt,
            reference: "Synthetic",
          },
        },
      };
      const tampered = structuredClone(input);
      tampered.packet.services[0]!.price = "0.01";
      await expect(caller().sync(tampered)).rejects.toThrow();
      await expect(caller(otherDoctor!).sync(input)).rejects.toThrow();
      const results = await Promise.all([
        caller().sync(input),
        caller().sync(input),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(
        await db
          .select()
          .from(schema.invoices)
          .where(eq(schema.invoices.patientId, patient!.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.invoiceId, results[0]!.invoiceId)),
      ).toHaveLength(1);
      const [batch] = await db
        .select()
        .from(schema.offlineFieldBatches)
        .where(eq(schema.offlineFieldBatches.id, packet.id));
      expect(batch!.receipt).toMatchObject({
        reference: packet.id,
        totalCents: 2000,
        paidCents: 1000,
        balanceCents: 1000,
      });
      const backup = await exportPracticeData(db, practice!.id, new Date().toISOString());
      expect(backup.offlineFieldBatches).toHaveLength(1);
      expect(backup.offlineFieldBatches[0]).toMatchObject({ receipt: batch!.receipt });
      const changed = structuredClone(input);
      changed.visit.sections.subjective = "Changed";
      await expect(caller().sync(changed)).rejects.toThrow(
        /different contents/,
      );
      vi.stubEnv("OFFLINE_FIELD_VISITS_ENABLED", "false");
      await expect(
        caller().prepare({ patientId: patient!.id }),
      ).rejects.toThrow();
      expect(await caller().sync(input)).toEqual(results[0]);
      await db
        .update(schema.users)
        .set({ isVeterinarian: false })
        .where(eq(schema.users.id, doctor!.id));
      await expect(caller().sync(input)).rejects.toThrow();
    } finally {
      process.env.DATABASE_URL = originalUrl;
      vi.unstubAllEnvs();
      await fixture.close();
    }
  }, 120_000);
});
