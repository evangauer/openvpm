import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  backupKey,
  coerceRowDates,
  PRACTICE_EXPORT_SECRET_REPLACEMENTS,
  PRACTICE_EXPORT_SYSTEM_EXCLUSIONS,
  PRACTICE_EXPORT_SECTIONS,
  restorePracticeData,
  sanitizePracticeExportRows,
  summarizePracticeExport,
  validatePracticeExportRestore,
} from "../export";
import { patients } from "@openpims/db";
import {
  PRACTICE_BACKUP_JSON_MAX_BYTES,
  isPracticeBackupJsonSizeValid,
  practiceBackupJsonByteLength,
} from "../policy";

describe("backup restore policy", () => {
  it("bounds direct backup JSON restore payloads by UTF-8 bytes", () => {
    expect(PRACTICE_BACKUP_JSON_MAX_BYTES).toBe(50_000_000);
    expect(practiceBackupJsonByteLength("é")).toBe(2);
    expect(isPracticeBackupJsonSizeValid("abc", 3)).toBe(true);
    expect(isPracticeBackupJsonSizeValid("abcd", 3)).toBe(false);
    expect(isPracticeBackupJsonSizeValid({ clients: [] }, 20)).toBe(true);
  });
});

describe("backupKey", () => {
  it("namespaces backups per practice and date", () => {
    expect(backupKey("prac-1", "2026-06-07")).toBe("backups/prac-1/2026-06-07.json");
  });
  it("keeps the practice id segment isolated", () => {
    const a = backupKey("a", "2026-06-07");
    const b = backupKey("b", "2026-06-07");
    expect(a).not.toBe(b);
    expect(a.startsWith("backups/a/")).toBe(true);
  });
});

function emptyBackup() {
  return Object.fromEntries(
    PRACTICE_EXPORT_SECTIONS.map((section) => [section, []])
  );
}

function restoreDb() {
  const inserted: { rows: Record<string, unknown>[] }[] = [];
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>[]) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => {
            inserted.push({ rows: values });
            return values.map((row) => ({ id: row.id }));
          }),
        })),
      })),
    })),
  };
  return { db, inserted };
}

const MERGE_OPERATION_ID = "00000000-0000-4000-8000-000000000011";

function patientIdentitySnapshot(id: string, name: string) {
  return {
    id,
    clientId: "client-1",
    name,
    species: "canine",
    breed: null,
    sex: null,
    dob: null,
    microchipNumber: null,
    externalSource: null,
    externalId: null,
  };
}

function validPatientMergeBackup() {
  return {
    practiceId: "practice-1",
    ...emptyBackup(),
    users: [
      {
        id: "user-1",
        practiceId: "practice-1",
        name: "Dr. Rivera",
      },
    ],
    clients: [{ id: "client-1", practiceId: "practice-1" }],
    patients: [
      {
        id: "source-1",
        practiceId: "practice-1",
        clientId: "client-1",
        name: "Roo duplicate",
        species: "canine",
        deletedAt: "2026-08-08T14:30:00.000Z",
      },
      {
        id: "target-1",
        practiceId: "practice-1",
        clientId: "client-1",
        name: "Roo",
        species: "canine",
        deletedAt: null,
      },
    ],
    patientMergeEvents: [
      {
        id: "merge-1",
        createdAt: "2026-08-08T14:30:00.000Z",
        practiceId: "practice-1",
        sourcePatientId: "source-1",
        targetPatientId: "target-1",
        clientId: "client-1",
        performedBy: "user-1",
        performedByName: "Dr. Rivera",
        reason: "Duplicate patient identity confirmed by clinic staff.",
        operationId: MERGE_OPERATION_ID,
        sourceSnapshot: patientIdentitySnapshot("source-1", "Roo duplicate"),
        targetSnapshot: patientIdentitySnapshot("target-1", "Roo"),
      },
    ],
  };
}

describe("summarizePracticeExport", () => {
  it("requires module-owned sections in full-practice backups", () => {
    expect(PRACTICE_EXPORT_SECTIONS).toContain("insurancePolicies");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("insuranceClaims");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("treatmentTemplates");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("treatmentTemplateItems");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("wellnessPlans");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("wellnessEnrollments");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("locationMessaging");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("smsSuppressions");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("emailSuppressions");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("webhooks");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("apiKeys");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("auditLog");
  });

  it("keeps volatile system ledgers out of restoreable practice backups", () => {
    const sections = PRACTICE_EXPORT_SECTIONS as readonly string[];

    expect(sections).not.toContain("usageRecords");
    expect(sections).not.toContain("practicePaymentAccounts");
    expect(sections).not.toContain("stripeEvents");
    expect(sections).not.toContain("rateLimitBuckets");
    expect(sections).not.toContain("messagingRegistrations");
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.usageRecords).toContain("billing");
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.practicePaymentAccounts).toContain(
      "Stripe Connect"
    );
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.messagingRegistrations).toContain(
      "Encrypted tax identity"
    );
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.messagingRegistrations).toContain(
      "operational database disaster recovery"
    );
  });

  it("counts present sections and reports missing sections", () => {
    const summary = summarizePracticeExport({
      clients: [{ id: "client-1" }],
      patients: [{ id: "patient-1" }],
      soapNotes: [{ id: "soap-1" }],
    });

    expect(summary.counts.clients).toBe(1);
    expect(summary.counts.patients).toBe(1);
    expect(summary.counts.soapNotes).toBe(1);
    expect(summary.missingSections).toContain("vitalSigns");
    expect(summary.missingSections).toContain("controlledSubstanceLog");
  });

  it("allows restoring older backups that predate email suppressions", () => {
    const backup = emptyBackup();
    delete (backup as Record<string, unknown>).emailSuppressions;

    const summary = summarizePracticeExport(backup);

    expect(summary.missingSections).not.toContain("emailSuppressions");
    expect(summary.counts.emailSuppressions).toBe(0);
  });

  it("allows restoring older backups that predate patient merge events", () => {
    const backup = emptyBackup();
    delete (backup as Record<string, unknown>).patientMergeEvents;

    const summary = summarizePracticeExport(backup);

    expect(summary.missingSections).not.toContain("patientMergeEvents");
    expect(summary.counts.patientMergeEvents).toBe(0);
  });
});

describe("exportPracticeData query scoping", () => {
  const source = readFileSync(new URL("../export.ts", import.meta.url), "utf8");

  it("exports parent-scoped children through active tenant parents", () => {
    const helper = source.match(
      /async function tenantParentChildRows[\s\S]+?async function restoreRows/
    )?.[0];

    expect(helper).toContain("inArray(parentColumn, parentIds)");
    expect(helper).toContain("where ${parentIdColumn} = ${parentColumn}");
    expect(helper).toContain("and ${parentTable.practiceId} = ${practiceId}");
    expect(helper).toContain("and ${parentTable.deletedAt} is null");
    expect(helper).toContain("isNull(table.deletedAt)");
    expect(source).toContain("tenantParentChildRows(\n      db,\n      patientWeights");
    expect(source).toContain("tenantParentChildRows(\n      db,\n      patientAllergies");
    expect(source).toContain("tenantParentChildRows(\n      db,\n      invoiceItems");
    expect(source).toContain("tenantParentChildRows(\n      db,\n      payments");
    expect(source).toContain("tenantParentChildRows(\n      db,\n      invoiceAdjustments");
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      treatmentTemplateItems"
    );
    expect(source).toContain("tenantParentChildRows(\n      db,\n      caseEntries");
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      treatmentPlanItems"
    );
  });

  it("exports complete merge events and retains their deleted source identities", () => {
    expect(source).toContain(
      "allPracticeRows(db, patientMergeEvents, practiceId)",
    );
    expect(source).toContain("...patientMergeRows.flatMap((event) => [");
    expect(source).toContain("event.sourcePatientId");
    expect(source).toContain("event.targetPatientId");
    expect(source).toContain("patientMergeEvents: patientMergeRows");
  });
});

describe("practice backup secret handling", () => {
  it("replaces credential material with restore-safe placeholders", () => {
    expect(
      sanitizePracticeExportRows("users", [
        {
          id: "user-1",
          passwordHash: "real-password-hash",
          emailVerifiedAt: new Date("2026-06-01T12:00:00Z"),
        },
      ])
    ).toEqual([
      {
        id: "user-1",
        passwordHash: PRACTICE_EXPORT_SECRET_REPLACEMENTS.passwordHash,
        emailVerifiedAt: null,
      },
    ]);

    expect(
      sanitizePracticeExportRows("clients", [
        { id: "client-1", accessToken: "portal-token" },
      ])
    ).toEqual([{ id: "client-1", accessToken: null }]);

    expect(
      sanitizePracticeExportRows("apiKeys", [
        {
          id: "api-key-1",
          keyPrefix: "ovpm_live123",
          keyHash: "stored-api-key-hash",
          lastUsedAt: new Date("2026-06-01T12:00:00Z"),
        },
      ])
    ).toEqual([
      {
        id: "api-key-1",
        keyPrefix: PRACTICE_EXPORT_SECRET_REPLACEMENTS.apiKeyPrefix,
        keyHash: PRACTICE_EXPORT_SECRET_REPLACEMENTS.apiKeyHash,
        lastUsedAt: null,
      },
    ]);

    expect(
      sanitizePracticeExportRows("webhooks", [
        {
          id: "webhook-1",
          secret: "stored-webhook-secret",
          active: true,
        },
      ])
    ).toEqual([
      {
        id: "webhook-1",
        secret: PRACTICE_EXPORT_SECRET_REPLACEMENTS.webhookSecret,
        active: false,
      },
    ]);

    expect(
      sanitizePracticeExportRows("auditLog", [
        {
          id: "audit-1",
          changes: {
            name: "Webhook setup",
            nested: {
              secret: "stored-secret",
              note: "keep me",
            },
            events: [{ apiKey: "raw-key", label: "created" }],
          },
        },
      ])
    ).toEqual([
      {
        id: "audit-1",
        changes: {
          name: "Webhook setup",
          nested: {
            secret: "[redacted]",
            note: "keep me",
          },
          events: [{ apiKey: "[redacted]", label: "created" }],
        },
      },
    ]);
  });
});

describe("restorePracticeData", () => {
  it("validates that restore references resolve inside the same backup", () => {
    const backup = {
      ...emptyBackup(),
      users: [{ id: "user-1" }],
      clients: [{ id: "client-1" }],
      patients: [{ id: "patient-1", clientId: "client-1" }],
      appointments: [
        {
          id: "appointment-1",
          clientId: "client-1",
          patientId: "patient-1",
        },
      ],
      invoices: [
        {
          id: "invoice-1",
          clientId: "client-1",
          patientId: "patient-1",
          appointmentId: "appointment-1",
        },
      ],
      invoiceItems: [{ id: "item-1", invoiceId: "invoice-1" }],
      soapNotes: [
        {
          id: "soap-1",
          patientId: "patient-1",
          appointmentId: "appointment-1",
          authorId: "user-1",
        },
      ],
    };

    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it("validates and restores immutable patient lineage after its parent rows", async () => {
    const backup = validPatientMergeBackup();
    // Identity snapshots are historical. A later edit to the canonical chart
    // must not make an otherwise factual backup unrestorable.
    backup.patients[1]!.name = "Roo Martinez";

    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });

    const { db, inserted } = restoreDb();
    await expect(
      restorePracticeData(db as never, "restored-practice", backup),
    ).resolves.toMatchObject({ restored: { patientMergeEvents: 1 } });

    const restoredRows = inserted.flatMap(({ rows }) => rows);
    const sourceIndex = restoredRows.findIndex((row) => row.id === "source-1");
    const targetIndex = restoredRows.findIndex((row) => row.id === "target-1");
    const mergeIndex = restoredRows.findIndex((row) => row.id === "merge-1");
    const mergeEvent = restoredRows[mergeIndex];

    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(mergeIndex).toBeGreaterThan(sourceIndex);
    expect(mergeIndex).toBeGreaterThan(targetIndex);
    expect(mergeEvent).toMatchObject({
      practiceId: "restored-practice",
      sourcePatientId: "source-1",
      targetPatientId: "target-1",
      clientId: "client-1",
      performedBy: "user-1",
      operationId: MERGE_OPERATION_ID,
      sourceSnapshot: patientIdentitySnapshot("source-1", "Roo duplicate"),
      targetSnapshot: patientIdentitySnapshot("target-1", "Roo"),
    });
    expect(mergeEvent?.createdAt).toBeInstanceOf(Date);
  });

  it("rejects patient lineage with invalid references, snapshots, attribution, or chart state", () => {
    const backup = validPatientMergeBackup();
    backup.users[0]!.practiceId = "other-practice";
    backup.patients[0]!.deletedAt = null;
    backup.patients[1]!.deletedAt = "2026-08-08T15:00:00.000Z";
    backup.patientMergeEvents[0]!.reason = "bad";
    backup.patientMergeEvents[0]!.performedByName = "";
    backup.patientMergeEvents[0]!.sourceSnapshot = {
      ...backup.patientMergeEvents[0]!.sourceSnapshot,
      id: "wrong-source",
    };

    expect(validatePracticeExportRestore(backup).errors).toEqual(
      expect.arrayContaining([
        "patientMergeEvents[merge-1].performedByName must be between 1 and 255 characters.",
        "patientMergeEvents[merge-1].reason must be between 5 and 500 characters.",
        "patientMergeEvents[merge-1].sourceSnapshot must be a valid patient identity snapshot.",
        "patientMergeEvents[merge-1].performedBy must belong to the declared practice.",
        "patientMergeEvents[merge-1].sourcePatientId must reference a soft-deleted source.",
        "patientMergeEvents[merge-1].targetPatientId must reference an active target.",
      ]),
    );
  });

  it("requires every patient lineage tenant reference to exist and agree", () => {
    const missing = validPatientMergeBackup();
    missing.practiceId = "different-backup-practice";
    missing.patientMergeEvents[0]!.sourcePatientId = "missing-source";
    missing.patientMergeEvents[0]!.targetPatientId = "missing-target";
    missing.patientMergeEvents[0]!.clientId = "missing-client";
    missing.patientMergeEvents[0]!.performedBy = "missing-user";
    missing.patientMergeEvents[0]!.sourceSnapshot = patientIdentitySnapshot(
      "missing-source",
      "Missing source",
    );
    missing.patientMergeEvents[0]!.sourceSnapshot.clientId = "missing-client";
    missing.patientMergeEvents[0]!.targetSnapshot = patientIdentitySnapshot(
      "missing-target",
      "Missing target",
    );
    missing.patientMergeEvents[0]!.targetSnapshot.clientId = "missing-client";

    expect(validatePracticeExportRestore(missing).errors).toEqual(
      expect.arrayContaining([
        'patientMergeEvents[merge-1].sourcePatientId references missing patients row "missing-source".',
        'patientMergeEvents[merge-1].targetPatientId references missing patients row "missing-target".',
        'patientMergeEvents[merge-1].clientId references missing clients row "missing-client".',
        'patientMergeEvents[merge-1].performedBy references missing users row "missing-user".',
        "patientMergeEvents[merge-1].practiceId must match the backup practiceId.",
      ]),
    );

    const mismatched = validPatientMergeBackup();
    mismatched.clients[0]!.practiceId = "other-practice";
    mismatched.users[0]!.practiceId = "other-practice";
    mismatched.patients[0]!.practiceId = "other-practice";
    mismatched.patients[1]!.clientId = "client-2";
    mismatched.clients.push({ id: "client-2", practiceId: "practice-1" });

    expect(validatePracticeExportRestore(mismatched).errors).toEqual(
      expect.arrayContaining([
        "patientMergeEvents[merge-1].sourcePatientId must share its client and practice.",
        "patientMergeEvents[merge-1].targetPatientId must share its client and practice.",
        "patientMergeEvents[merge-1].clientId must belong to the declared practice.",
        "patientMergeEvents[merge-1].performedBy must belong to the declared practice.",
      ]),
    );
  });

  it("rejects duplicate and chained patient lineage within a practice", () => {
    const duplicate = validPatientMergeBackup();
    duplicate.patientMergeEvents.push({
      ...duplicate.patientMergeEvents[0]!,
      id: "merge-2",
      operationId: "00000000-0000-4000-8000-000000000012",
    });
    duplicate.patientMergeEvents.push({
      ...duplicate.patientMergeEvents[0]!,
      id: "merge-3",
      operationId: MERGE_OPERATION_ID,
    });

    expect(validatePracticeExportRestore(duplicate).errors).toEqual(
      expect.arrayContaining([
        "patientMergeEvents[merge-2].sourcePatientId must be unique within its practice.",
        "patientMergeEvents[merge-3].operationId must be unique within its practice.",
      ]),
    );

    const chained = validPatientMergeBackup();
    chained.patients.push({
      id: "target-2",
      practiceId: "practice-1",
      clientId: "client-1",
      name: "Roo canonical",
      species: "canine",
      deletedAt: null,
    });
    chained.patientMergeEvents.push({
      ...chained.patientMergeEvents[0]!,
      id: "merge-2",
      sourcePatientId: "target-1",
      targetPatientId: "target-2",
      operationId: "00000000-0000-4000-8000-000000000012",
      sourceSnapshot: patientIdentitySnapshot("target-1", "Roo"),
      targetSnapshot: patientIdentitySnapshot("target-2", "Roo canonical"),
    });

    expect(validatePracticeExportRestore(chained).errors).toContain(
      "patientMergeEvents[merge-2] cannot use an existing merge target as a source.",
    );
  });

  it("requires correction events to match their typed source patient and appointment", () => {
    const backup = {
      ...emptyBackup(),
      users: [{ id: "user-1" }],
      clients: [{ id: "client-1" }],
      patients: [
        { id: "patient-1", clientId: "client-1" },
        { id: "patient-2", clientId: "client-1" },
      ],
      appointments: [
        {
          id: "appointment-1",
          clientId: "client-1",
          patientId: "patient-1",
        },
        {
          id: "appointment-2",
          clientId: "client-1",
          patientId: "patient-2",
        },
      ],
      soapNotes: [
        {
          id: "soap-1",
          patientId: "patient-1",
          appointmentId: "appointment-1",
          authorId: "user-1",
        },
      ],
      vitalSigns: [
        {
          id: "vital-1",
          patientId: "patient-1",
          appointmentId: null,
          recordedBy: "user-1",
        },
      ],
      clinicalRecordCorrections: [
        {
          id: "correction-1",
          recordType: "soap_note",
          soapNoteId: "soap-1",
          vitalSignId: null,
          patientId: "patient-1",
          appointmentId: "appointment-1",
          correctedBy: "user-1",
        },
        {
          id: "correction-2",
          recordType: "vital_sign",
          soapNoteId: null,
          vitalSignId: "vital-1",
          patientId: "patient-1",
          appointmentId: null,
          correctedBy: "user-1",
        },
      ],
    };

    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });

    expect(
      validatePracticeExportRestore({
        ...backup,
        clinicalRecordCorrections: [
          {
            ...backup.clinicalRecordCorrections[0],
            patientId: "patient-2",
            appointmentId: "appointment-2",
          },
        ],
      }).errors
    ).toContain(
      "clinicalRecordCorrections[correction-1] must match its source record patientId and appointmentId exactly."
    );

    expect(
      validatePracticeExportRestore({
        ...backup,
        clinicalRecordCorrections: [
          {
            ...backup.clinicalRecordCorrections[0],
            recordType: "lab_result",
          },
        ],
      }).errors
    ).toContain(
      "clinicalRecordCorrections[correction-1].recordType must be soap_note or vital_sign."
    );
  });

  it("rejects a SOAP or vital appointment owned by another patient", () => {
    const backup = {
      ...emptyBackup(),
      users: [{ id: "user-1" }],
      clients: [{ id: "client-1" }],
      patients: [
        { id: "patient-1", clientId: "client-1" },
        { id: "patient-2", clientId: "client-1" },
      ],
      appointments: [
        {
          id: "appointment-1",
          clientId: "client-1",
          patientId: "patient-2",
        },
      ],
      soapNotes: [
        {
          id: "soap-1",
          patientId: "patient-1",
          appointmentId: "appointment-1",
          authorId: "user-1",
        },
      ],
    };

    expect(validatePracticeExportRestore(backup).errors).toContain(
      "soapNotes[soap-1].appointmentId must reference an appointment for the same patient."
    );
  });

  it("reports malformed restore references before inserts run", async () => {
    const backup = {
      ...emptyBackup(),
      clients: [{ id: "client-1" }],
      appointments: [{ id: "appointment-1", clientId: "other-client" }],
      patientWeights: [{ id: "weight-1", patientId: "other-patient" }],
    };
    const { db, inserted } = restoreDb();

    expect(validatePracticeExportRestore(backup).errors).toContain(
      'appointments[appointment-1].clientId references missing clients row "other-client".'
    );

    await expect(
      restorePracticeData(db as never, "target-practice", backup)
    ).rejects.toThrow("Backup contains invalid restore data");
    expect(inserted).toEqual([]);
  });

  it("rejects a pending dispense queue row already linked to an invoice item", () => {
    const backup = {
      ...emptyBackup(),
      users: [{ id: "user-1" }],
      clients: [{ id: "client-1" }],
      patients: [{ id: "patient-1", clientId: "client-1" }],
      appointments: [
        {
          id: "appointment-1",
          clientId: "client-1",
          patientId: "patient-1",
        },
      ],
      products: [{ id: "product-1" }],
      prescriptions: [
        {
          id: "prescription-1",
          patientId: "patient-1",
          appointmentId: "appointment-1",
          productId: "product-1",
          quantity: 1,
          prescribedBy: "user-1",
        },
      ],
      prescriptionEvents: [
        {
          id: "event-1",
          prescriptionId: "prescription-1",
          patientId: "patient-1",
          productId: "product-1",
          quantity: 1,
          eventType: "created",
          actorId: "user-1",
        },
      ],
      invoices: [
        {
          id: "invoice-1",
          clientId: "client-1",
          patientId: "patient-1",
          appointmentId: "appointment-1",
        },
      ],
      invoiceItems: [
        {
          id: "invoice-item-1",
          invoiceId: "invoice-1",
          sourceDispenseChargeId: "dispense-1",
        },
      ],
      dispenseChargeQueue: [
        {
          id: "dispense-1",
          prescriptionEventId: "event-1",
          prescriptionId: "prescription-1",
          patientId: "patient-1",
          clientId: "client-1",
          appointmentId: "appointment-1",
          productId: "product-1",
          status: "pending",
          invoiceId: null,
          invoiceItemId: null,
          resolvedBy: null,
          resolvedByName: null,
          resolvedAt: null,
          resolutionReason: null,
        },
      ],
    };

    expect(validatePracticeExportRestore(backup).errors).toContain(
      "dispenseChargeQueue[dispense-1] pending state must be completely unresolved.",
    );
  });

  it("rejects a present prescription ledger that omits a created event", () => {
    const backup = {
      ...emptyBackup(),
      users: [{ id: "user-1" }],
      clients: [{ id: "client-1" }],
      patients: [{ id: "patient-1", clientId: "client-1" }],
      prescriptions: [
        {
          id: "rx-1",
          patientId: "patient-1",
          prescribedBy: "user-1",
          productId: null,
          quantity: 30,
        },
      ],
      prescriptionEvents: [],
    };

    expect(validatePracticeExportRestore(backup)).toMatchObject({
      valid: false,
      errors: [
        "prescriptions[rx-1] must have exactly one created prescription event.",
      ],
    });
  });

  it("synthesizes a factual created event for a legacy backup", async () => {
    const current = {
      ...emptyBackup(),
      users: [{ id: "user-1", name: "Dr. Rivera" }],
      clients: [{ id: "client-1" }],
      patients: [{ id: "patient-1", clientId: "client-1" }],
      prescriptions: [
        {
          id: "rx-1",
          practiceId: "source-practice",
          createdAt: "2026-08-01T12:00:00.000Z",
          patientId: "patient-1",
          productId: null,
          medicationName: "Carprofen",
          quantity: 30,
          refillsRemaining: 2,
          prescribedBy: "user-1",
          operationId: "00000000-0000-0000-0000-000000000009",
        },
      ],
    };
    const { prescriptionEvents: _omitted, ...legacy } = current as Record<
      string,
      unknown
    >;
    const { db, inserted } = restoreDb();

    await expect(
      restorePracticeData(db as never, "target-practice", legacy),
    ).resolves.toMatchObject({
      restored: { prescriptionEvents: 1 },
    });
    const createdEvent = inserted
      .flatMap(({ rows }) => rows)
      .find((row) => row.prescriptionId === "rx-1");
    expect(createdEvent).toMatchObject({
      practiceId: "target-practice",
      prescriptionId: "rx-1",
      patientId: "patient-1",
      productId: null,
      quantity: 30,
      eventType: "created",
      statusBefore: null,
      statusAfter: "active",
      refillsBefore: null,
      refillsAfter: 2,
      reason:
        "Restored from pre-ledger backup; earlier refill history unavailable.",
      actorId: "user-1",
      actorName: "Dr. Rivera",
      operationId: "00000000-0000-0000-0000-000000000009",
    });
    expect(createdEvent?.createdAt).toBeInstanceOf(Date);
  });

  it("rejects a malformed present prescription ledger instead of treating it as legacy", async () => {
    const backup = {
      ...emptyBackup(),
      prescriptionEvents: { malformed: true },
    };
    const { db, inserted } = restoreDb();

    expect(summarizePracticeExport(backup).missingSections).toContain(
      "prescriptionEvents",
    );
    await expect(
      restorePracticeData(db as never, "target-practice", backup),
    ).rejects.toThrow("Backup is missing required sections: prescriptionEvents");
    expect(inserted).toEqual([]);
  });

  it("reports malformed restore rows before inserts run", async () => {
    const backup = {
      ...emptyBackup(),
      clients: [
        "not-a-row",
        { firstName: "Missing", lastName: "Id" },
        { id: 42, firstName: "Numeric", lastName: "Id" },
        { id: " ", firstName: "Blank", lastName: "Id" },
      ],
    };
    const { db, inserted } = restoreDb();

    expect(validatePracticeExportRestore(backup).errors).toEqual(
      expect.arrayContaining([
        "clients[#1] must be an object row.",
        "clients[#2].id is required.",
        "clients[#3].id must be a non-empty string.",
        "clients[#4].id must be a non-empty string.",
      ])
    );

    await expect(
      restorePracticeData(db as never, "target-practice", backup)
    ).rejects.toThrow("Backup contains invalid restore data");
    expect(inserted).toEqual([]);
  });

  it("coerces JSON timestamp strings into Dates before insert", async () => {
    // A real backup file round-trips through JSON, so every timestamp is an
    // ISO string; pg timestamp columns reject those (value.toISOString crash).
    const backup = {
      ...emptyBackup(),
      clients: [
        {
          id: "client-1",
          practiceId: "source-practice",
          createdAt: "2026-07-01T12:00:00.000Z",
          updatedAt: "2026-07-02T12:00:00.000Z",
        },
      ],
      patients: [
        {
          id: "patient-1",
          practiceId: "source-practice",
          clientId: "client-1",
          createdAt: "2026-07-01T12:00:00.000Z",
          dob: "2020-05-01",
        },
      ],
    };
    const { db, inserted } = restoreDb();

    await restorePracticeData(db as never, "target-practice", backup);
    const restoredRows = inserted.flatMap(({ rows }) => rows);
    const client = restoredRows.find((row) => row.id === "client-1");
    const patient = restoredRows.find((row) => row.id === "patient-1");

    expect(client?.createdAt).toBeInstanceOf(Date);
    expect(client?.updatedAt).toBeInstanceOf(Date);
    expect((client?.createdAt as Date).toISOString()).toBe(
      "2026-07-01T12:00:00.000Z"
    );
    expect(patient?.createdAt).toBeInstanceOf(Date);
    // String-mode date columns (calendar dates) stay strings.
    expect(patient?.dob).toBe("2020-05-01");
  });

  it("leaves null, absent, and unparseable timestamp values unchanged", () => {
    const rows = coerceRowDates(patients, [
      { id: "patient-1", createdAt: null, deletedAt: undefined },
      { id: "patient-2", createdAt: "not-a-date" },
      { id: "patient-3", createdAt: new Date("2026-07-01T12:00:00.000Z") },
    ]);

    expect(rows[0].createdAt).toBeNull();
    expect(rows[1].createdAt).toBe("not-a-date");
    expect(rows[2].createdAt).toBeInstanceOf(Date);
  });

  it("wraps direct restore helper calls in a database transaction when available", async () => {
    const backup = {
      ...emptyBackup(),
      clients: [{ id: "client-1", practiceId: "source-practice" }],
    };
    const { db: tx, inserted } = restoreDb();
    const rootDb = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    };

    const result = await restorePracticeData(
      rootDb as never,
      "target-practice",
      backup
    );
    const restoredRows = inserted.flatMap(({ rows }) => rows);

    expect(rootDb.transaction).toHaveBeenCalledTimes(1);
    expect(result.totalRows).toBe(1);
    expect(restoredRows).toContainEqual(
      expect.objectContaining({
        id: "client-1",
        practiceId: "target-practice",
      })
    );
  });

  it("rewrites practice-scoped rows and leaves parent-scoped child rows intact", async () => {
    const backup = {
      ...emptyBackup(),
      locations: [{ id: "location-1", practiceId: "source-practice" }],
      locationMessaging: [
        {
          id: "location-messaging-1",
          practiceId: "source-practice",
          locationId: "location-1",
        },
      ],
      smsSuppressions: [
        {
          id: "suppression-1",
          practiceId: "source-practice",
          phone: "+15555550100",
        },
      ],
      emailSuppressions: [
        {
          id: "email-suppression-1",
          practiceId: "source-practice",
          email: "ada@example.com",
          reason: "bounce",
        },
      ],
      webhooks: [
        {
          id: "webhook-1",
          practiceId: "source-practice",
          url: "https://example.test/openvpm",
          secret: "whsec_placeholder",
          events: ["invoice.paid"],
        },
      ],
      apiKeys: [
        {
          id: "api-key-1",
          practiceId: "source-practice",
          keyPrefix: "ovpm_test",
          keyHash: "api_hash_placeholder",
          name: "Integration key",
          scopes: ["clients:read"],
        },
      ],
      auditLog: [
        {
          id: "audit-1",
          practiceId: "source-practice",
          action: "create",
          entityType: "clients",
        },
      ],
      clients: [{ id: "client-1", practiceId: "source-practice" }],
      users: [{ id: "user-1", practiceId: "source-practice" }],
      patients: [
        {
          id: "patient-1",
          practiceId: "source-practice",
          clientId: "client-1",
        },
      ],
      insurancePolicies: [
        {
          id: "policy-1",
          practiceId: "source-practice",
          clientId: "client-1",
          patientId: "patient-1",
        },
      ],
      insuranceClaims: [
        { id: "claim-1", practiceId: "source-practice", policyId: "policy-1" },
      ],
      wellnessPlans: [
        { id: "wellness-plan-1", practiceId: "source-practice", name: "Puppy" },
      ],
      wellnessEnrollments: [
        {
          id: "wellness-enrollment-1",
          practiceId: "source-practice",
          planId: "wellness-plan-1",
          clientId: "client-1",
        },
      ],
      treatmentTemplates: [
        { id: "template-1", practiceId: "source-practice", name: "Dental" },
      ],
      treatmentTemplateItems: [
        { id: "template-item-1", templateId: "template-1" },
      ],
      patientWeights: [{ id: "weight-1", patientId: "patient-1" }],
      files: [
        {
          id: "file-1",
          practiceId: "source-practice",
          uploadedBy: "user-1",
        },
      ],
    };
    const { db, inserted } = restoreDb();

    const result = await restorePracticeData(db as never, "target-practice", backup);
    const restoredRows = inserted.flatMap(({ rows }) => rows);

    expect(result.totalRows).toBe(18);
    expect(restoredRows.find((row) => row.id === "location-1")).toMatchObject({
      id: "location-1",
      practiceId: "target-practice",
    });
    expect(
      restoredRows.find((row) => row.id === "location-messaging-1")
    ).toMatchObject({
      id: "location-messaging-1",
      practiceId: "target-practice",
    });
    expect(restoredRows.find((row) => row.id === "suppression-1")).toMatchObject({
      id: "suppression-1",
      practiceId: "target-practice",
    });
    expect(
      restoredRows.find((row) => row.id === "email-suppression-1")
    ).toMatchObject({
      id: "email-suppression-1",
      practiceId: "target-practice",
      email: "ada@example.com",
    });
    expect(restoredRows.find((row) => row.id === "webhook-1")).toMatchObject({
      id: "webhook-1",
      practiceId: "target-practice",
      secret: PRACTICE_EXPORT_SECRET_REPLACEMENTS.webhookSecret,
      active: false,
    });
    expect(restoredRows.find((row) => row.id === "api-key-1")).toMatchObject({
      id: "api-key-1",
      practiceId: "target-practice",
      keyPrefix: PRACTICE_EXPORT_SECRET_REPLACEMENTS.apiKeyPrefix,
      keyHash: PRACTICE_EXPORT_SECRET_REPLACEMENTS.apiKeyHash,
      lastUsedAt: null,
    });
    expect(restoredRows.find((row) => row.id === "audit-1")).toMatchObject({
      id: "audit-1",
      practiceId: "target-practice",
    });
    expect(restoredRows.find((row) => row.id === "client-1")).toMatchObject({
      id: "client-1",
      practiceId: "target-practice",
      accessToken: null,
    });
    expect(restoredRows.find((row) => row.id === "user-1")).toMatchObject({
      id: "user-1",
      practiceId: "target-practice",
      passwordHash: PRACTICE_EXPORT_SECRET_REPLACEMENTS.passwordHash,
      emailVerifiedAt: null,
    });
    expect(restoredRows.find((row) => row.id === "patient-1")).toMatchObject({
      id: "patient-1",
      practiceId: "target-practice",
      clientId: "client-1",
    });
    expect(restoredRows.find((row) => row.id === "policy-1")).toMatchObject({
      id: "policy-1",
      practiceId: "target-practice",
    });
    expect(restoredRows.find((row) => row.id === "claim-1")).toMatchObject({
      id: "claim-1",
      practiceId: "target-practice",
    });
    expect(
      restoredRows.find((row) => row.id === "wellness-plan-1")
    ).toMatchObject({
      id: "wellness-plan-1",
      practiceId: "target-practice",
    });
    expect(
      restoredRows.find((row) => row.id === "wellness-enrollment-1")
    ).toMatchObject({
      id: "wellness-enrollment-1",
      practiceId: "target-practice",
    });
    expect(restoredRows.find((row) => row.id === "template-1")).toMatchObject({
      id: "template-1",
      practiceId: "target-practice",
    });
    expect(restoredRows.find((row) => row.id === "template-item-1")).toEqual({
      id: "template-item-1",
      templateId: "template-1",
    });
    expect(restoredRows.find((row) => row.id === "weight-1")).toEqual({
      id: "weight-1",
      patientId: "patient-1",
    });
    expect(restoredRows.find((row) => row.id === "file-1")).toMatchObject({
      id: "file-1",
      practiceId: "target-practice",
    });
  });

  it("refuses to restore a legacy backup missing required sections", async () => {
    const { db } = restoreDb();

    await expect(
      restorePracticeData(db as never, "target-practice", {
        clients: [],
        patients: [],
      })
    ).rejects.toThrow("Backup is missing required sections");
  });
});
