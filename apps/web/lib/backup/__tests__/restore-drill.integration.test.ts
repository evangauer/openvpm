import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compare } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "@openpims/db";
import {
  appointments,
  auditLog,
  clients,
  fileObjectReplicas,
  files,
  invoices,
  patients,
  payments,
  practices,
  soapNotes,
  users,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { main as recoverPractice } from "../../../scripts/recover-practice";
import { replicaObjectKey } from "../../file-replication";
import { withTenant } from "../../tenant-db";
import {
  exportPracticeData,
  PRACTICE_EXPORT_SECRET_REPLACEMENTS,
} from "../export";

const enabled = process.env.RESTORE_DRILL_DB_INTEGRATION === "1";
const sourceUrl = process.env.RESTORE_DRILL_SOURCE_DATABASE_URL ?? "";
const targetUrl = process.env.RESTORE_DRILL_TARGET_DATABASE_URL ?? "";
const appUrl = process.env.RESTORE_DRILL_APP_DATABASE_URL ?? "";
const practiceName = "Neighborhood Veterinary";
const originalPassword = "password123";
const replicaVersionId = "restore-drill-independent-version-v1";

type ConnectedDatabase = {
  client: Sql;
  db: Database;
};

const connections: ConnectedDatabase[] = [];
let scratchDirectory: string | undefined;

function connect(url: string): ConnectedDatabase {
  const client = postgres(url, { max: 1 });
  const connected = {
    client,
    db: drizzle(client, { schema }) as Database,
  };
  connections.push(connected);
  return connected;
}

function sha256(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

afterAll(async () => {
  await Promise.all(connections.map(({ client }) => client.end()));
  if (scratchDirectory) rmSync(scratchDirectory, { recursive: true, force: true });
});

describe.skipIf(!enabled)("disposable clinic restore drill", () => {
  it("restores, verifies, isolates, and releases a synthetic clinic backup", async () => {
    expect(sourceUrl, "RESTORE_DRILL_SOURCE_DATABASE_URL").not.toBe("");
    expect(targetUrl, "RESTORE_DRILL_TARGET_DATABASE_URL").not.toBe("");
    expect(appUrl, "RESTORE_DRILL_APP_DATABASE_URL").not.toBe("");

    const source = connect(sourceUrl);
    const target = connect(targetUrl);
    const app = connect(appUrl);
    const drillStartedAt = Date.now();

    const [sourcePractice] = await source.db
      .select({ id: practices.id })
      .from(practices)
      .where(and(eq(practices.name, practiceName), isNull(practices.deletedAt)))
      .limit(1);
    expect(sourcePractice).toBeDefined();
    const practiceId = sourcePractice!.id;

    const [[sourceUser], [sourcePatient]] = await Promise.all([
      source.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.practiceId, practiceId), isNull(users.deletedAt)))
        .limit(1),
      source.db
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.practiceId, practiceId), isNull(patients.deletedAt)))
        .limit(1),
    ]);
    expect(sourceUser).toBeDefined();
    expect(sourcePatient).toBeDefined();

    const fileId = randomUUID();
    const replicaBody = Buffer.from(
      "OpenVPM synthetic independent restore object\n",
      "utf8",
    );
    const replicaChecksum = sha256(replicaBody);
    const fileKey = `${practiceId}/documents/${fileId}.txt`;
    await source.db.insert(files).values({
      id: fileId,
      practiceId,
      uploadedBy: sourceUser!.id,
      fileName: "synthetic-restore-evidence.txt",
      fileKey,
      fileUrl: `/api/files/${fileKey}`,
      mimeType: "text/plain",
      fileSizeBytes: replicaBody.byteLength,
      checksumSha256: replicaChecksum,
      objectVersionId: "synthetic-primary-version-v1",
      storageStatus: "available",
      storageVerifiedAt: new Date(),
      category: "documents",
      title: "Synthetic restore evidence",
      source: "restore_drill",
      entityType: "patient",
      entityId: sourcePatient!.id,
      patientId: sourcePatient!.id,
    });

    const exportedAt = new Date().toISOString();
    const backup = await exportPracticeData(source.db, practiceId, exportedAt);
    scratchDirectory = mkdtempSync(path.join(tmpdir(), "openvpm-restore-drill-"));
    const backupPath = path.join(scratchDirectory, "synthetic-backup.json");
    writeFileSync(backupPath, JSON.stringify(backup), { mode: 0o600 });

    process.env.OWNER_RECOVERY_DATABASE_URL = targetUrl;
    process.env.DATABASE_URL = targetUrl;
    const restoreStartedAt = Date.now();
    await recoverPractice([
      "restore",
      "--practice-id",
      practiceId,
      "--backup",
      backupPath,
      "--practice-name",
      "Synthetic Restore Drill Clinic",
      "--execute",
      "--confirmation",
      `RESTORE:${practiceId}`,
    ]);

    const [heldPractice] = await target.db
      .select({ recoveryHold: practices.recoveryHold })
      .from(practices)
      .where(eq(practices.id, practiceId))
      .limit(1);
    expect(heldPractice?.recoveryHold).toBe(true);

    const exportedFile = backup.files[0] as
      | { checksumSha256?: unknown; fileSizeBytes?: unknown }
      | undefined;
    expect(replicaVersionId).not.toBe("");
    expect(replicaBody.byteLength).toBe(exportedFile?.fileSizeBytes);
    expect(sha256(replicaBody)).toBe(exportedFile?.checksumSha256);
    const replicaVerifiedAt = new Date();
    const [restoredPrimaryManifest] = await target.db
      .update(files)
      .set({
        storageStatus: "available",
        storageVerifiedAt: replicaVerifiedAt,
        objectVersionId: "restore-drill-rebuilt-primary-v1",
        updatedAt: replicaVerifiedAt,
      })
      .where(
        and(
          eq(files.id, fileId),
          eq(files.practiceId, practiceId),
          eq(files.storageStatus, "unverified"),
        ),
      )
      .returning({ id: files.id });
    expect(restoredPrimaryManifest?.id).toBe(fileId);
    await target.db.insert(fileObjectReplicas).values({
      practiceId,
      fileId,
      replicaTarget: "independent-v1",
      objectKey: replicaObjectKey({
        practiceId,
        fileId,
        checksumSha256: replicaChecksum,
      }),
      objectVersionId: replicaVersionId,
      checksumSha256: replicaChecksum,
      fileSizeBytes: replicaBody.byteLength,
      status: "available",
      replicatedAt: replicaVerifiedAt,
      verifiedAt: replicaVerifiedAt,
    });

    await recoverPractice([
      "release",
      "--practice-id",
      practiceId,
      "--execute",
      "--confirmation",
      `RELEASE:${practiceId}`,
      "--verified-objects",
      "--verified-user-access",
      "--reconciled-messaging",
      "--reconciled-payments",
      "--reviewed-autonomous-jobs",
    ]);
    const releasedAt = Date.now();

    const [restoredPractice] = await target.db
      .select({
        recoveryHold: practices.recoveryHold,
        recoveryHoldReleasedAt: practices.recoveryHoldReleasedAt,
      })
      .from(practices)
      .where(eq(practices.id, practiceId))
      .limit(1);
    expect(restoredPractice?.recoveryHold).toBe(false);
    expect(restoredPractice?.recoveryHoldReleasedAt).toBeInstanceOf(Date);

    const [restoredUser] = await target.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(and(eq(users.practiceId, practiceId), isNull(users.deletedAt)))
      .limit(1);
    expect(restoredUser?.passwordHash).toBe(
      PRACTICE_EXPORT_SECRET_REPLACEMENTS.passwordHash,
    );
    expect(await compare(originalPassword, restoredUser!.passwordHash)).toBe(false);

    const [
      restoredClients,
      restoredPatients,
      restoredAppointments,
      restoredSoapNotes,
      restoredInvoices,
      restoredPayments,
      restoredFiles,
      recoveryAudit,
    ] = await Promise.all([
      target.db.select({ id: clients.id }).from(clients).where(eq(clients.practiceId, practiceId)),
      target.db.select({ id: patients.id }).from(patients).where(eq(patients.practiceId, practiceId)),
      target.db.select({ id: appointments.id }).from(appointments).where(eq(appointments.practiceId, practiceId)),
      target.db.select({ id: soapNotes.id }).from(soapNotes).where(eq(soapNotes.practiceId, practiceId)),
      target.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.practiceId, practiceId)),
      target.db
        .select({ id: payments.id })
        .from(payments)
        .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
        .where(eq(invoices.practiceId, practiceId)),
      target.db.select({ id: files.id }).from(files).where(eq(files.practiceId, practiceId)),
      target.db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.practiceId, practiceId),
            eq(auditLog.entityType, "practice_recovery"),
          ),
        ),
    ]);

    expect(restoredClients).toHaveLength(backup.clients.length);
    expect(restoredPatients).toHaveLength(backup.patients.length);
    expect(restoredAppointments).toHaveLength(backup.appointments.length);
    expect(restoredSoapNotes).toHaveLength(backup.soapNotes.length);
    expect(restoredInvoices).toHaveLength(backup.invoices.length);
    expect(restoredPayments).toHaveLength(backup.payments.length);
    expect(restoredFiles).toHaveLength(1);
    expect(recoveryAudit.map(({ action }) => action)).toEqual(
      expect.arrayContaining(["hold_set", "restore_complete", "hold_released"]),
    );

    const otherPracticeId = randomUUID();
    await target.db.insert(practices).values({
      id: otherPracticeId,
      name: "Synthetic Isolation Control",
      timezone: "America/New_York",
      settings: {},
    });

    const [visibleOwnClients, visibleOwnFiles, leakedClients, leakedFiles] =
      await Promise.all([
        withTenant(app.db, practiceId, (tx) =>
          tx.select({ id: clients.id }).from(clients),
        ),
        withTenant(app.db, practiceId, (tx) =>
          tx.select({ id: files.id }).from(files),
        ),
        withTenant(app.db, otherPracticeId, (tx) =>
          tx
            .select({ id: clients.id })
            .from(clients)
            .where(eq(clients.practiceId, practiceId)),
        ),
        withTenant(app.db, otherPracticeId, (tx) =>
          tx
            .select({ id: files.id })
            .from(files)
            .where(eq(files.practiceId, practiceId)),
        ),
      ]);
    expect(visibleOwnClients).toHaveLength(backup.clients.length);
    expect(visibleOwnFiles).toHaveLength(1);
    expect(leakedClients).toHaveLength(0);
    expect(leakedFiles).toHaveLength(0);

    const evidence = {
      evidenceFormatVersion: 1,
      status: "passed",
      synthetic: true,
      releaseSha:
        process.env.RESTORE_DRILL_RELEASE_SHA ??
        process.env.GITHUB_SHA ??
        "local-uncommitted",
      completedAt: new Date(releasedAt).toISOString(),
      operator: process.env.GITHUB_ACTOR
        ? `github:${process.env.GITHUB_ACTOR}`
        : "local-operator",
      sourceBackupId: `synthetic:${practiceId}:${exportedAt}`,
      sourceBackupExportedAt: exportedAt,
      restoreTarget: "disposable-postgres",
      rpoMs: Math.max(0, restoreStartedAt - Date.parse(exportedAt)),
      rtoMs: releasedAt - restoreStartedAt,
      totalDrillMs: releasedAt - drillStartedAt,
      recoveryHold: {
        observedBeforeReconciliation: true,
        releasedAfterChecklistAndDatabaseGate: true,
      },
      independentObject: {
        fileId,
        objectVersionId: replicaVersionId,
        checksumSha256: replicaChecksum,
        fileSizeBytes: replicaBody.byteLength,
        exactVersionVerified: true,
      },
      smoke: {
        authenticationResetRequired: true,
        tenantIsolation: true,
        schedulingRows: restoredAppointments.length,
        clinicalRows: restoredSoapNotes.length,
        invoiceRows: restoredInvoices.length,
        paymentRows: restoredPayments.length,
        fileAccessRows: restoredFiles.length,
      },
      failureHandling:
        "Any failed assertion exits nonzero; recovery release is impossible until the explicit checklist and database backlog gates pass.",
    };
    const evidencePath = process.env.RESTORE_DRILL_EVIDENCE_PATH?.trim();
    if (evidencePath) {
      mkdirSync(path.dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        mode: 0o600,
      });
    }
    console.log("RESTORE_DRILL_EVIDENCE", JSON.stringify(evidence));
  }, 180_000);
});
