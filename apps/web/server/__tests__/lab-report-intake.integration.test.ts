import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as schema from "../../../../packages/db/schema/index";
import { createRouter, type TRPCContext } from "../trpc";
import { labReportsRouter } from "../routers/lab-reports";
import { patientsRouter } from "../routers/patients";
import { receiveLabReport } from "@/lib/lab-report-intake";
import { withTenant } from "@/lib/tenant-db";
import {
  reserveManagedUpload,
  finalizeManagedUploadManifest,
} from "@/lib/managed-file-upload";
import {
  exportPracticeData,
  restorePracticeData,
  validatePracticeExportRestore,
} from "@/lib/backup/export";
import {
  disposableClinic,
  type DisposableClinic,
} from "./helpers/disposable-clinic";
vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchWebhookEvent: vi.fn() }));
const integration =
  process.env.LAB_REPORT_DB_INTEGRATION === "1" ? describe : describe.skip;

integration("Lab report intake on restricted PostgreSQL", () => {
  it("deduplicates originals, isolates clinics, serializes decisions, preserves revisions and restores their history", async () => {
    const fixture = await disposableClinic();
    const originalUrl = process.env.DATABASE_URL;
    let target: DisposableClinic | undefined;
    vi.stubEnv("NEXT_PUBLIC_LAB_REPORT_INTAKE_ENABLED", "true");
    try {
      process.env.DATABASE_URL = fixture.appUrl;
      const [clinic, foreign] = await fixture.ownerDb
        .insert(schema.practices)
        .values([
          { name: "Synthetic lab clinic" },
          { name: "Other synthetic clinic" },
        ])
        .returning();
      const [doctor, tech, other] = await fixture.ownerDb
        .insert(schema.users)
        .values([
          {
            practiceId: clinic!.id,
            name: "Doctor",
            role: "veterinarian" as const,
            email: "lab-doctor@example.invalid",
            passwordHash: "synthetic",
          },
          {
            practiceId: clinic!.id,
            name: "Technician",
            role: "technician" as const,
            email: "lab-tech@example.invalid",
            passwordHash: "synthetic",
          },
          {
            practiceId: foreign!.id,
            name: "Other doctor",
            role: "veterinarian" as const,
            email: "lab-other@example.invalid",
            passwordHash: "synthetic",
          },
        ])
        .returning();
      const [client, foreignClient] = await fixture.ownerDb
        .insert(schema.clients)
        .values([
          { practiceId: clinic!.id, firstName: "Synthetic", lastName: "Owner" },
          { practiceId: foreign!.id, firstName: "Other", lastName: "Owner" },
        ])
        .returning();
      const [patient, second, foreignPatient] = await fixture.ownerDb
        .insert(schema.patients)
        .values([
          {
            practiceId: clinic!.id,
            clientId: client!.id,
            name: "Scout",
            species: "canine" as const,
          },
          {
            practiceId: clinic!.id,
            clientId: client!.id,
            name: "Scout Two",
            species: "canine" as const,
          },
          {
            practiceId: foreign!.id,
            clientId: foreignClient!.id,
            name: "Foreign Scout",
            species: "canine" as const,
          },
        ])
        .returning();
      const router = createRouter({
        labReports: labReportsRouter,
        patients: patientsRouter,
      });
      function caller(user = doctor!) {
        return router.createCaller({
          db: fixture.db,
          session: {
            user: {
              id: user.id,
              practiceId: user.practiceId,
              name: user.name,
              email: user.email,
              role: user.role,
            },
            expires: "2099-01-01",
          },
        } as TRPCContext);
      }
      async function receive(
        digest: string,
        previous: string | null = null,
        user = doctor!,
      ) {
        return withTenant(fixture.db, user.practiceId, async (tx) => {
          const reservation = await reserveManagedUpload(tx, {
            practiceId: user.practiceId,
            uploadedBy: user.id,
            idempotencyKey: randomUUID(),
            fileName: "Synthetic report.pdf",
            mimeType: "application/pdf",
            fileSizeBytes: 200,
            checksumSha256: digest.repeat(64),
            category: "lab-results",
            source: "lab_report_upload",
            entityType: "practice",
            entityId: user.practiceId,
          });
          await finalizeManagedUploadManifest(tx, reservation, {
            url: reservation.fileUrl,
          });
          return receiveLabReport(tx, reservation, previous);
        });
      }
      const [a, b] = await Promise.all([receive("a"), receive("a")]);
      expect(a.reportId).toBe(b.reportId);
      expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
      const reports = caller().labReports;
      expect((await reports.list({})).items).toHaveLength(1);
      expect((await caller(other!).labReports.list({})).items).toHaveLength(0);
      const foreignReport = await receive("a", null, other!);
      expect(foreignReport.reportId).not.toBe(a.reportId);
      const match = {
        id: a.reportId,
        operationId: randomUUID(),
        expectedVersion: 0,
        state: "matched" as const,
        patientId: patient!.id,
      };
      await expect(
        reports.decide({ ...match, patientId: foreignPatient!.id }),
      ).rejects.toThrow("Patient is unavailable");
      await expect(caller(other!).labReports.decide(match)).rejects.toThrow(
        "Report not found",
      );
      const concurrent = await Promise.allSettled([
        reports.decide(match),
        reports.decide({
          ...match,
          operationId: randomUUID(),
          patientId: second!.id,
        }),
      ]);
      expect(concurrent.filter((x) => x.status === "fulfilled")).toHaveLength(
        1,
      );
      let row = (await reports.list({ filter: "all" })).items[0]!;
      expect(row.version).toBe(1);
      const winningPatient = row.patientId!;
      const review = {
        id: a.reportId,
        operationId: randomUUID(),
        expectedVersion: 1,
        state: "reviewed" as const,
        patientId: winningPatient,
      };
      await expect(caller(tech!).labReports.decide(review)).rejects.toThrow(
        "veterinarian",
      );
      const reviewed = await reports.decide(review);
      expect(await reports.decide(review)).toEqual(reviewed);
      await expect(
        reports.decide({
          ...review,
          patientId: second!.id === winningPatient ? patient!.id : second!.id,
        }),
      ).rejects.toThrow("already used");
      expect(
        (await reports.list({ filter: "all", patientId: winningPatient }))
          .items[0]!.state,
      ).toBe("reviewed");
      const revision = await receive("b", a.reportId);
      expect(
        (await reports.list({ filter: "all", reportId: a.reportId })).items[0]!
          .revisionIds,
      ).toEqual([revision.reportId]);
      expect(
        (await reports.list({ reportId: revision.reportId })).items[0]!.state,
      ).toBe("unmatched");
      await expect(receive("a", a.reportId)).rejects.toThrow("same file");
      await expect(receive("c", foreignReport.reportId)).rejects.toThrow(
        "previous report",
      );
      await expect(
        reports.decide({
          ...review,
          operationId: randomUUID(),
          expectedVersion: 2,
          state: "unmatched",
          patientId: null,
        }),
      ).rejects.toThrow("reason");
      const correct = {
        ...review,
        operationId: randomUUID(),
        expectedVersion: 2,
        state: "unmatched" as const,
        patientId: null,
        reason: "Patient identity requires another check",
      };
      await reports.decide(correct);
      await expect(
        reports.decide({ ...review, operationId: randomUUID() }),
      ).rejects.toThrow("another session");
      expect(await reports.decide(review)).toEqual(reviewed); // Old exact retry doesn't revive reviewed state.
      expect(
        (await reports.list({ filter: "all", reportId: a.reportId })).items[0]!
          .state,
      ).toBe("unmatched");
      expect(await reports.history({ id: a.reportId })).toHaveLength(3);
      await expect(
        withTenant(fixture.db, clinic!.id, (tx) =>
          tx
            .update(schema.labReportDecisions)
            .set({ reason: "tampered" })
            .where(eq(schema.labReportDecisions.reportId, a.reportId)),
        ),
      ).rejects.toThrow();
      await expect(
        fixture.ownerDb
          .delete(schema.labReportReceipts)
          .where(eq(schema.labReportReceipts.id, a.reportId)),
      ).rejects.toThrow();
      const restrictedRows = await withTenant(fixture.db, clinic!.id, (tx) =>
        tx.select().from(schema.labReportReceipts),
      );
      expect(restrictedRows.every((r) => r.practiceId === clinic!.id)).toBe(
        true,
      );
      await expect(
        withTenant(fixture.db, clinic!.id, (tx) =>
          tx.insert(schema.labReportDecisions).values({
            practiceId: clinic!.id,
            reportId: a.reportId,
            actorId: doctor!.id,
            patientId: foreignPatient!.id,
            state: "matched",
            operationId: randomUUID(),
            version: 4,
          }),
        ),
      ).rejects.toThrow();
      await fixture.ownerDb
        .update(schema.users)
        .set({ role: "front_desk" })
        .where(eq(schema.users.id, doctor!.id));
      await expect(reports.list({})).rejects.toThrow("access");
      await fixture.ownerDb
        .update(schema.users)
        .set({ role: "veterinarian" })
        .where(eq(schema.users.id, doctor!.id));
      await fixture.ownerDb
        .update(schema.practices)
        .set({
          recoveryHold: true,
          recoveryHoldReason: "Synthetic restore test",
          recoveryHoldSetAt: new Date(),
        })
        .where(eq(schema.practices.id, clinic!.id));
      await expect(
        reports.decide({
          ...match,
          expectedVersion: 3,
          operationId: randomUUID(),
        }),
      ).rejects.toThrow("recovery");
      await fixture.ownerDb
        .update(schema.practices)
        .set({ recoveryHold: false })
        .where(eq(schema.practices.id, clinic!.id));
      vi.stubEnv("NEXT_PUBLIC_LAB_REPORT_INTAKE_ENABLED", "false");
      await expect(reports.list({})).rejects.toThrow();
      vi.stubEnv("NEXT_PUBLIC_LAB_REPORT_INTAKE_ENABLED", "true");
      // Include superseded and unmatched evidence, original files and retired actors.
      const backup = await withTenant(fixture.db, clinic!.id, (tx) =>
        exportPracticeData(tx, clinic!.id, new Date().toISOString()),
      );
      const transported = JSON.parse(JSON.stringify(backup));
      const invalidFile = structuredClone(transported);
      invalidFile.labReportReceipts[0].checksumSha256 = "f".repeat(64);
      expect(validatePracticeExportRestore(invalidFile).valid).toBe(false);
      const invalidReview = structuredClone(transported);
      invalidReview.labReportDecisions.find(
        (d: { state: string }) => d.state === "reviewed",
      ).patientId = foreignPatient!.id;
      expect(validatePracticeExportRestore(invalidReview).valid).toBe(false);
      const missingDecision = structuredClone(transported);
      missingDecision.labReportDecisions =
        missingDecision.labReportDecisions.filter(
          (d: { version: number }) => d.version !== 1,
        );
      expect(validatePracticeExportRestore(missingDecision).valid).toBe(false);
      transported.labReportReceipts.reverse(); // restore must not depend on JSON ordering
      expect(transported.labReportReceipts).toHaveLength(2);
      expect(transported.labReportDecisions).toHaveLength(3);
      process.env.DATABASE_URL = originalUrl;
      target = await disposableClinic();
      const [destination] = await target.ownerDb
        .insert(schema.practices)
        .values({ id: clinic!.id, name: "Synthetic restored reports" })
        .returning();
      await withTenant(target.db, destination!.id, (tx) =>
        restorePracticeData(tx, destination!.id, transported, {
          recoveryHoldDb: target!.db,
        }),
      );
      const restored = await withTenant(target.db, destination!.id, (tx) =>
        exportPracticeData(tx, destination!.id, new Date().toISOString()),
      );
      expect(restored.labReportReceipts).toHaveLength(2);
      expect(restored.labReportDecisions).toHaveLength(3);
      expect(restored.files.length).toBe(backup.files.length);
      expect(
        restored.labReportReceipts.every(
          (r) => (r as { practiceId: string }).practiceId === destination!.id,
        ),
      ).toBe(true);
      const [restoredPractice] = await target.ownerDb
        .select()
        .from(schema.practices)
        .where(eq(schema.practices.id, destination!.id));
      expect(restoredPractice!.recoveryHold).toBe(true);
      expect(
        await fixture.ownerDb
          .select()
          .from(schema.labResults)
          .where(eq(schema.labResults.practiceId, clinic!.id)),
      ).toHaveLength(0);
    } finally {
      process.env.DATABASE_URL = originalUrl;
      vi.unstubAllEnvs();
      await target?.close();
      await fixture.close();
    }
  }, 180_000);
});
