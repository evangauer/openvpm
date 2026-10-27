import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import {
  restorePracticeData,
  exportPracticeData,
  PRACTICE_EXPORT_SECRET_REPLACEMENTS,
} from "@/lib/backup/export";
import { withTenant, withTenantReadOnlySnapshot } from "@/lib/tenant-db";
import {
  disposableClinic,
  type DisposableClinic,
} from "./helpers/disposable-clinic";
import { runGoldenClinic } from "./helpers/golden-clinic";

vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchWebhookEvent: vi.fn() }));

const integration =
  process.env.DISPOSABLE_RESTORE_DB_INTEGRATION === "1"
    ? describe
    : describe.skip;
integration("Disposable restore drill", () => {
  it("restores a completed synthetic clinic, rolls back a failed restore and retains the recovery hold", async () => {
    const source = await disposableClinic();
    const originalUrl = process.env.DATABASE_URL;
    let target: DisposableClinic | undefined;
    try {
      process.env.DATABASE_URL = source.appUrl;
      const scenario = await runGoldenClinic(source);
      // Exercise the JSON download/upload boundary, including timestamp coercion.
      const backup = JSON.parse(JSON.stringify(scenario.backup));
      // Older backups have no visibility marker; those notes must stay private.
      for (const note of backup.clinicalNotes) {
        if (note.id === scenario.internalNote.id) delete note.isChartNote;
      }
      process.env.DATABASE_URL = originalUrl;
      target = await disposableClinic();
      const practiceId = randomUUID();
      const [destination, unrelated] = await target.ownerDb
        .insert(schema.practices)
        .values([
          { id: practiceId, name: "Synthetic restored clinic" },
          { name: "Unrelated synthetic target clinic" },
        ])
        .returning();
      const restore = () =>
        withTenant(target!.db, practiceId, (tx) =>
          restorePracticeData(tx, practiceId, backup, {
            recoveryHoldDb: target!.db,
          }),
        );
      const invalid = structuredClone(backup);
      invalid.patients[0].clientId = randomUUID();
      await expect(
        withTenant(target.db, practiceId, (tx) =>
          restorePracticeData(tx, practiceId, invalid, {
            recoveryHoldDb: target!.db,
          }),
        ),
      ).rejects.toThrow("invalid restore data");
      expect(
        (
          await target.ownerDb
            .select()
            .from(schema.practices)
            .where(eq(schema.practices.id, practiceId))
        )[0]?.recoveryHold,
      ).toBe(false);
      // Fail after earlier sections have actually inserted, inside the real transaction.
      await target.owner.unsafe(`
        create function fail_synthetic_restore() returns trigger language plpgsql as $$
        begin raise exception 'synthetic restore failure'; end $$;
        create trigger fail_synthetic_restore before insert on clinical_notes
          for each row execute function fail_synthetic_restore();
      `);
      await expect(restore()).rejects.toThrow();
      for (const table of [
        schema.clients,
        schema.patients,
        schema.invoices,
        schema.soapNotes,
      ]) {
        expect(await target.ownerDb.select().from(table)).toEqual([]);
      }
      const [held] = await target.ownerDb
        .select()
        .from(schema.practices)
        .where(eq(schema.practices.id, practiceId));
      expect(held).toMatchObject({
        recoveryHold: true,
        recoveryHoldReleasedAt: null,
      });
      expect(held?.recoveryHoldSetAt).toBeInstanceOf(Date);
      await target.owner.unsafe(
        "drop trigger fail_synthetic_restore on clinical_notes",
      );
      const result = await restore();
      expect(result.restored.patients).toBe(1);
      expect(result.restored.payments).toBe(1);
      expect(result.restored.visitCloseouts).toBe(1);
      const restored = await withTenantReadOnlySnapshot(
        target.db,
        practiceId,
        (tx) => exportPracticeData(tx, practiceId, new Date().toISOString()),
      );
      for (const section of [
        "clients",
        "patients",
        "appointments",
        "soapNotes",
        "vitalSigns",
        "procedures",
        "invoices",
        "invoiceItems",
        "payments",
        "clinicalNotes",
        "visitCloseouts",
      ] as const) {
        expect(restored[section].length, section).toBe(
          scenario.backup[section].length,
        );
      }
      expect(restored.soapNotes[0]).toMatchObject({
        id: scenario.soap.id,
        subjective: scenario.soap.subjective,
        status: "finalized",
        authorId: scenario.doctor.id,
        practiceId,
      });
      expect(restored.clinicalNotes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: scenario.internalNote.id,
            content: scenario.internalNote.content,
            authorId: scenario.doctor.id,
            practiceId,
            isChartNote: false,
          }),
          expect.objectContaining({
            id: scenario.chartNote.id,
            content: scenario.chartNote.content,
            authorId: scenario.doctor.id,
            practiceId,
            isChartNote: true,
          }),
        ]),
      );
      const { patientNotesRouter } = await import("../routers/patient-notes");
      const restoredContext = scenario.context();
      restoredContext.db = target.db;
      restoredContext.session!.user.practiceId = practiceId;
      restoredContext.session!.user.recoveryHold = true;
      const visible = await patientNotesRouter
        .createCaller(restoredContext)
        .list({ patientId: scenario.patient.id });
      expect(visible.items.map((note) => note.id)).toEqual([
        scenario.chartNote.id,
      ]);
      expect(restored.payments[0]).toMatchObject({
        invoiceId: scenario.invoice.id,
        amount: "19.44",
      });
      expect(restored.visitCloseouts[0]).toMatchObject({
        status: "completed",
        invoiceId: scenario.invoice.id,
        dischargeInstructions:
          scenario.completed.closeout.dischargeInstructions,
      });
      // Inspect stored values directly: a second export would sanitize them again
      // and could conceal an unsafe restore of credentials or portal access.
      expect(
        (await target.ownerDb.select().from(schema.users))[0],
      ).toMatchObject({
        passwordHash: PRACTICE_EXPORT_SECRET_REPLACEMENTS.passwordHash,
        emailVerifiedAt: null,
      });
      expect(
        (await target.ownerDb.select().from(schema.clients))[0],
      ).toMatchObject({ accessToken: null });
      expect(
        (await target.ownerDb.select().from(schema.webhooks))[0],
      ).toMatchObject({
        active: false,
        secret: PRACTICE_EXPORT_SECRET_REPLACEMENTS.webhookSecret,
      });
      expect(
        (await target.ownerDb.select().from(schema.apiKeys))[0],
      ).toMatchObject({
        keyPrefix: "disabled",
        keyHash: PRACTICE_EXPORT_SECRET_REPLACEMENTS.apiKeyHash,
      });
      expect(restored.practice.appointmentRemindersEnabled).toBe(false);
      expect(
        (
          await target.ownerDb
            .select()
            .from(schema.practices)
            .where(eq(schema.practices.id, destination!.id))
        )[0]?.recoveryHold,
      ).toBe(true);
      expect(
        (
          await target.ownerDb
            .select()
            .from(schema.practices)
            .where(eq(schema.practices.id, unrelated!.id))
        )[0]?.recoveryHold,
      ).toBe(false);
      expect(
        await withTenant(target.db, unrelated!.id, (tx) =>
          tx.select().from(schema.patients),
        ),
      ).toEqual([]);
      expect(await target.db.select().from(schema.patients)).toEqual([]);
    } finally {
      process.env.DATABASE_URL = originalUrl;
      await target?.close();
      await source.close();
    }
  }, 360_000);
});
