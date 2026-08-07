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
