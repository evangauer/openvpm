import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  backupKey,
  coerceRowDates,
  PRACTICE_EXPORT_SECRET_REPLACEMENTS,
  PRACTICE_EXPORT_AUDIT_ONLY_SECTIONS,
  PRACTICE_EXPORT_FORMAT_VERSION,
  PRACTICE_EXPORT_SYSTEM_EXCLUSIONS,
  PRACTICE_EXPORT_SECTIONS,
  prepareLegacySmsConsentRestore,
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

function soapAddendumHash(noteId: string, authorId: string, content: string) {
  return createHash("sha256")
    .update(JSON.stringify({ noteId, authorId, content }))
    .digest("hex");
}

const SOAP_BACKUP_USER_ID = "00000000-0000-4000-8000-000000000041";
const SOAP_SOURCE_ID = "00000000-0000-4000-8000-000000000042";
const SOAP_REPLACEMENT_ID = "00000000-0000-4000-8000-000000000043";
const SOAP_RETIRED_ID = "00000000-0000-4000-8000-000000000044";
const SOAP_ADDENDUM_SOURCE_ID = "00000000-0000-4000-8000-000000000045";
const SOAP_ADDENDUM_RETIRED_ID = "00000000-0000-4000-8000-000000000046";
const SOAP_REPLACEMENT_LINK_ID = "00000000-0000-4000-8000-000000000047";
const SOAP_CORRECTION_ID = "00000000-0000-4000-8000-000000000048";
const SOAP_REPLACEMENT_OPERATION_ID = "00000000-0000-4000-8000-000000000049";

function validSoapReplacementBackup() {
  const practiceId = "00000000-0000-4000-8000-000000000040";
  const clientId = "00000000-0000-4000-8000-000000000051";
  const patientId = "00000000-0000-4000-8000-000000000050";
  const reason = "Assessment was signed on the wrong encounter.";
  const replacementSections = {
    subjective: "Corrected history",
    objective: null,
    assessment: "Corrected assessment",
    plan: null,
  };
  const operationPayloadHash = createHash("sha256")
    .update(
      JSON.stringify({
        patientId,
        sourceNoteId: SOAP_SOURCE_ID,
        actorId: SOAP_BACKUP_USER_ID,
        reason,
        ...replacementSections,
      }),
    )
    .digest("hex");
  return {
    practiceId,
    ...emptyBackup(),
    users: [
      {
        id: SOAP_BACKUP_USER_ID,
        practiceId,
        name: "Dr. Rivera",
      },
    ],
    clients: [{ id: clientId, practiceId }],
    patients: [{ id: patientId, practiceId, clientId }],
    soapNotes: [
      {
        id: SOAP_SOURCE_ID,
        practiceId,
        patientId,
        appointmentId: null,
        authorId: SOAP_BACKUP_USER_ID,
        authorName: "Dr. Rivera",
        status: "finalized",
        deletedAt: null,
        finalizedAt: "2026-08-09T16:00:00.000Z",
        finalizedBy: SOAP_BACKUP_USER_ID,
        finalizerName: "Dr. Rivera",
        subjective: "Wrong history",
        objective: null,
        assessment: "Wrong assessment",
        plan: null,
      },
      {
        id: SOAP_REPLACEMENT_ID,
        practiceId,
        patientId,
        appointmentId: null,
        authorId: SOAP_BACKUP_USER_ID,
        authorName: "Dr. Rivera",
        status: "finalized",
        deletedAt: null,
        finalizedAt: "2026-08-09T16:10:00.000Z",
        finalizedBy: SOAP_BACKUP_USER_ID,
        finalizerName: "Dr. Rivera",
        ...replacementSections,
      },
    ],
    clinicalRecordCorrections: [
      {
        id: SOAP_CORRECTION_ID,
        createdAt: "2026-08-09T16:05:00.000Z",
        practiceId,
        recordType: "soap_note",
        soapNoteId: SOAP_SOURCE_ID,
        vitalSignId: null,
        vaccinationRecordId: null,
        labResultId: null,
        patientId,
        appointmentId: null,
        reason,
        correctedBy: SOAP_BACKUP_USER_ID,
        operationId: null,
        operationPayloadHash: null,
      },
    ],
    soapNoteReplacements: [
      {
        id: SOAP_REPLACEMENT_LINK_ID,
        createdAt: "2026-08-09T16:15:00.000Z",
        practiceId,
        correctionId: SOAP_CORRECTION_ID,
        sourceSoapNoteId: SOAP_SOURCE_ID,
        replacementSoapNoteId: SOAP_REPLACEMENT_ID,
        actorId: SOAP_BACKUP_USER_ID,
        actorName: "Dr. Rivera",
        operationId: SOAP_REPLACEMENT_OPERATION_ID,
        operationPayloadHash,
      },
    ],
  };
}

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
    expect(backupKey("prac-1", "2026-06-07")).toBe(
      "backups/prac-1/2026-06-07.json",
    );
  });
  it("keeps the practice id segment isolated", () => {
    const a = backupKey("a", "2026-06-07");
    const b = backupKey("b", "2026-06-07");
    expect(a).not.toBe(b);
    expect(a.startsWith("backups/a/")).toBe(true);
  });
});

function emptyBackup(): Record<string, unknown[]> {
  return Object.fromEntries(
    PRACTICE_EXPORT_SECTIONS.map((section) => [section, []]),
  );
}

function restoreDb(executeResults: unknown[][] = []) {
  const inserted: { rows: Record<string, unknown>[] }[] = [];
  const executed: unknown[] = [];
  const timeline: string[] = [];
  const pendingExecuteResults = [...executeResults];
  const db = {
    execute: vi.fn(async (query: unknown) => {
      executed.push(query);
      timeline.push("execute");
      return (
        pendingExecuteResults.shift() ?? [
          {
            result_id:
              executed.length === 1
                ? SOAP_ADDENDUM_SOURCE_ID
                : SOAP_ADDENDUM_RETIRED_ID,
            was_inserted: true,
          },
        ]
      );
    }),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>[]) => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () => {
            inserted.push({ rows: values });
            timeline.push(...values.map((row) => `insert:${String(row.id)}`));
            return values.map((row) => ({ id: row.id }));
          }),
        })),
      })),
    })),
  };
  return { db, inserted, executed, timeline };
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

const LAB_CORRECTION_OPERATION_1 = "00000000-0000-4000-8000-000000000021";
const LAB_CORRECTION_OPERATION_2 = "00000000-0000-4000-8000-000000000022";
const LAB_REPLACEMENT_OPERATION_1 = "00000000-0000-4000-8000-000000000023";
const LAB_REPLACEMENT_OPERATION_2 = "00000000-0000-4000-8000-000000000024";

function validLabReplacementBackup() {
  const operationHash = "a".repeat(64);
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
        id: "patient-1",
        practiceId: "practice-1",
        clientId: "client-1",
      },
    ],
    labResults: ["lab-1", "lab-2", "lab-3"].map((id) => ({
      id,
      practiceId: "practice-1",
      patientId: "patient-1",
      appointmentId: null,
      orderedBy: "user-1",
    })),
    clinicalRecordCorrections: [
      {
        id: "correction-1",
        practiceId: "practice-1",
        recordType: "lab_result",
        soapNoteId: null,
        vitalSignId: null,
        vaccinationRecordId: null,
        labResultId: "lab-1",
        patientId: "patient-1",
        appointmentId: null,
        correctedBy: "user-1",
        operationId: LAB_CORRECTION_OPERATION_1,
        operationPayloadHash: operationHash,
      },
      {
        id: "correction-2",
        practiceId: "practice-1",
        recordType: "lab_result",
        soapNoteId: null,
        vitalSignId: null,
        vaccinationRecordId: null,
        labResultId: "lab-2",
        patientId: "patient-1",
        appointmentId: null,
        correctedBy: "user-1",
        operationId: LAB_CORRECTION_OPERATION_2,
        operationPayloadHash: operationHash,
      },
    ],
    labResultReplacements: [
      {
        id: "replacement-link-1",
        practiceId: "practice-1",
        correctionId: "correction-1",
        sourceLabResultId: "lab-1",
        replacementLabResultId: "lab-2",
        actorId: "user-1",
        actorName: "Dr. Rivera",
        operationId: LAB_REPLACEMENT_OPERATION_1,
        operationPayloadHash: operationHash,
      },
      {
        id: "replacement-link-2",
        practiceId: "practice-1",
        correctionId: "correction-2",
        sourceLabResultId: "lab-2",
        replacementLabResultId: "lab-3",
        actorId: "user-1",
        actorName: "Dr. Rivera",
        operationId: LAB_REPLACEMENT_OPERATION_2,
        operationPayloadHash: operationHash,
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
    expect(PRACTICE_EXPORT_SECTIONS).toContain("smsConsentEvents");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("smsSendAttempts");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("smsSendAttemptEvents");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("smsDeliveryEvents");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("smsDeliveryEventHistory");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("emailSuppressions");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("webhooks");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("apiKeys");
    expect(PRACTICE_EXPORT_SECTIONS).toContain("auditLog");
  });

  it("requires replacement lineage in current backups but accepts its legacy absence", () => {
    const currentMissing: Record<string, unknown> = {
      formatVersion: 5,
      ...emptyBackup(),
    };
    delete currentMissing["labResultReplacements"];
    expect(summarizePracticeExport(currentMissing).missingSections).toContain(
      "labResultReplacements",
    );
    const currentSoapMissing: Record<string, unknown> = {
      formatVersion: 5,
      ...emptyBackup(),
    };
    delete currentSoapMissing["soapNoteReplacements"];
    expect(
      summarizePracticeExport(currentSoapMissing).missingSections,
    ).toContain("soapNoteReplacements");

    const legacyMissing: Record<string, unknown> = { ...emptyBackup() };
    delete legacyMissing["labResultReplacements"];
    delete legacyMissing["soapNoteReplacements"];
    expect(
      summarizePracticeExport(legacyMissing).missingSections,
    ).not.toContain("labResultReplacements");
    expect(
      summarizePracticeExport(legacyMissing).missingSections,
    ).not.toContain("soapNoteReplacements");
  });

  it("exports SMS provider ledgers for audit but marks them owner-restore only", () => {
    expect(PRACTICE_EXPORT_AUDIT_ONLY_SECTIONS.smsSendAttempts).toContain(
      "trusted owner-maintenance disaster recovery",
    );
    expect(PRACTICE_EXPORT_AUDIT_ONLY_SECTIONS.smsSendAttemptEvents).toContain(
      "must not recreate",
    );
    expect(PRACTICE_EXPORT_AUDIT_ONLY_SECTIONS.smsDeliveryEvents).toContain(
      "Environment-bound",
    );
  });

  it("keeps volatile system ledgers out of restoreable practice backups", () => {
    const sections = PRACTICE_EXPORT_SECTIONS as readonly string[];

    expect(sections).not.toContain("usageRecords");
    expect(sections).not.toContain("practicePaymentAccounts");
    expect(sections).not.toContain("stripeEvents");
    expect(sections).not.toContain("practiceConversionMilestones");
    expect(sections).not.toContain("rateLimitBuckets");
    expect(sections).not.toContain("messagingRegistrations");
    expect(sections).not.toContain("authEmailAttempts");
    expect(sections).not.toContain("authEmailDeliveryEvents");
    expect(sections).not.toContain("authEmailWebhookConflicts");
    expect(sections).not.toContain("authEmailProviderIdentityConflicts");
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.usageRecords).toContain("billing");
    expect(
      PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.practiceConversionMilestones,
    ).toContain("Repairable system analytics projection");
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.practicePaymentAccounts).toContain(
      "Stripe Connect",
    );
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.messagingRegistrations).toContain(
      "Encrypted tax identity",
    );
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.messagingRegistrations).toContain(
      "operational database disaster recovery",
    );
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.authEmailAttempts).toContain(
      "provider identity",
    );
    expect(PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.authEmailDeliveryEvents).toContain(
      "immutable",
    );
    expect(
      PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.authEmailWebhookConflicts,
    ).toContain("conflict evidence");
    expect(
      PRACTICE_EXPORT_SYSTEM_EXCLUSIONS.authEmailProviderIdentityConflicts,
    ).toContain("provider identity conflict evidence");
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

  it("allows restoring older backups that predate SMS consent events", () => {
    const backup = emptyBackup();
    delete (backup as Record<string, unknown>).smsConsentEvents;

    const summary = summarizePracticeExport(backup);

    expect(summary.missingSections).not.toContain("smsConsentEvents");
    expect(summary.counts.smsConsentEvents).toBe(0);
  });

  it("synthesizes only truthful legacy consent and clears incomplete projections", () => {
    const backup = emptyBackup();
    delete (backup as Record<string, unknown>).smsConsentEvents;
    backup.clients = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        practiceId: "source-practice",
        phone: "+1 (555) 555-0100",
        smsConsent: true,
        smsConsentAt: "2026-08-01T12:00:00.000Z",
        smsConsentSource: "staff_attested_form:v1",
        smsConsentDisclosure: "Exact historical disclosure",
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        practiceId: "source-practice",
        phone: "+05555550101",
        smsConsent: true,
        smsConsentAt: "2026-08-01T12:00:00.000Z",
        smsConsentSource: "intake",
        smsConsentDisclosure: "Incomplete historical evidence",
      },
    ];

    const prepared = prepareLegacySmsConsentRestore(backup);

    expect(prepared.clients[0]).toMatchObject({ smsConsent: true });
    expect(prepared.smsConsentEvents).toHaveLength(1);
    expect(prepared.smsConsentEvents[0]).toMatchObject({
      clientId: "00000000-0000-0000-0000-000000000001",
      destinationE164: "+15555550100",
      action: "granted",
      source: "staff_attested_form:v1",
      disclosureVersion: "v1",
      disclosure: "Exact historical disclosure",
      actorType: "system",
      occurredAt: "2026-08-01T12:00:00.000Z",
    });
    expect(prepared.clients[1]).toMatchObject({
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });
  });

  it("clears a modern affirmative projection without a matching destination grant", () => {
    const backup = emptyBackup();
    backup.clients = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        phone: "+15555550100",
        smsConsent: true,
        smsConsentAt: "2026-08-01T12:00:00.000Z",
        smsConsentSource: "staff_attested_form:v1",
        smsConsentDisclosure: "Exact historical disclosure",
      },
    ];

    expect(prepareLegacySmsConsentRestore(backup).clients[0]).toMatchObject({
      smsConsent: false,
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentDisclosure: null,
    });

    backup.smsConsentEvents = [
      {
        id: "00000000-0000-0000-0000-000000000010",
        clientId: "00000000-0000-0000-0000-000000000001",
        destinationE164: "+15555550100",
        action: "granted",
        occurredAt: "2026-08-01T12:00:00.000Z",
      },
    ];
    expect(prepareLegacySmsConsentRestore(backup).clients[0]).toMatchObject({
      smsConsent: true,
      phone: "+15555550100",
    });

    const destinationRevoke = {
      id: "00000000-0000-0000-0000-000000000011",
      clientId: "00000000-0000-0000-0000-000000000099",
      destinationE164: "+15555550100",
      action: "revoked",
      occurredAt: "2026-08-01T12:00:00.000Z",
    };
    backup.smsConsentEvents.push(destinationRevoke);
    expect(prepareLegacySmsConsentRestore(backup).clients[0]).toMatchObject({
      smsConsent: false,
      smsConsentAt: null,
    });

    destinationRevoke.occurredAt = "2026-08-02T12:00:00.000Z";
    expect(prepareLegacySmsConsentRestore(backup).clients[0]).toMatchObject({
      smsConsent: false,
      smsConsentAt: null,
    });
  });

  it("restores a truthful pre-ledger projection with its synthesized event", async () => {
    const backup = emptyBackup();
    delete (backup as Record<string, unknown>).smsConsentEvents;
    backup.clients = [
      {
        id: "00000000-0000-0000-0000-000000000001",
        practiceId: "source-practice",
        phone: "+15555550100",
        smsConsent: true,
        smsConsentAt: "2026-08-01T12:00:00.000Z",
        smsConsentSource: "staff_attested_form:v1",
        smsConsentDisclosure: "Exact historical disclosure",
      },
    ];
    const { db, inserted } = restoreDb();

    const result = await restorePracticeData(
      db as never,
      "target-practice",
      backup,
    );
    const restoredRows = inserted.flatMap(({ rows }) => rows);

    expect(result.restored.clients).toBe(1);
    expect(result.restored.smsConsentEvents).toBe(1);
    expect(restoredRows).toContainEqual(
      expect.objectContaining({
        practiceId: "target-practice",
        clientId: "00000000-0000-0000-0000-000000000001",
        destinationE164: "+15555550100",
        action: "granted",
        actorType: "system",
        occurredAt: new Date("2026-08-01T12:00:00.000Z"),
      }),
    );
  });
});

describe("location-aware scheduling backup compatibility", () => {
  const practiceId = "practice-location-backup";
  const locationId = "location-1";
  const otherLocationId = "location-2";
  const roomId = "room-1";
  const appointmentId = "appointment-1";

  function schedulingBackup() {
    return {
      formatVersion: PRACTICE_EXPORT_FORMAT_VERSION,
      practiceId,
      ...emptyBackup(),
      locations: [
        {
          id: locationId,
          practiceId,
          name: "Main Clinic",
          isPrimary: true,
          deletedAt: null,
        },
      ],
      rooms: [
        {
          id: roomId,
          practiceId,
          locationId,
          name: "Exam 1",
          deletedAt: null,
        },
      ],
      appointments: [
        {
          id: appointmentId,
          practiceId,
          locationId,
          roomId,
        },
      ],
    };
  }

  it("requires explicit room and appointment locations in v5 backups", () => {
    const missingRoomLocation = schedulingBackup();
    delete (missingRoomLocation.rooms[0] as Record<string, unknown>).locationId;
    expect(validatePracticeExportRestore(missingRoomLocation).errors).toContain(
      "rooms[room-1].locationId is required in backup format v5.",
    );

    const missingAppointmentLocation = schedulingBackup();
    delete (
      missingAppointmentLocation.appointments[0] as Record<string, unknown>
    ).locationId;
    expect(
      validatePracticeExportRestore(missingAppointmentLocation).errors,
    ).toContain(
      "appointments[appointment-1].locationId is required in backup format v5.",
    );
  });

  it("rejects appointment rooms from another clinic location", () => {
    const backup = schedulingBackup();
    backup.locations.push({
      id: otherLocationId,
      practiceId,
      name: "North Clinic",
      isPrimary: false,
      deletedAt: null,
    });
    backup.appointments[0]!.locationId = otherLocationId;

    expect(validatePracticeExportRestore(backup).errors).toContain(
      "appointments[appointment-1].roomId must belong to the appointment location.",
    );
  });

  it("rejects more than one active primary clinic location", () => {
    const backup = schedulingBackup();
    backup.locations.push({
      id: otherLocationId,
      practiceId,
      name: "North Clinic",
      isPrimary: true,
      deletedAt: null,
    });

    expect(validatePracticeExportRestore(backup).errors).toContain(
      "locations must contain at most one active primary location.",
    );
  });

  it("derives sole-location room and appointment links for legacy backups", async () => {
    const backup = schedulingBackup();
    backup.formatVersion = 4;
    delete (backup.rooms[0] as Record<string, unknown>).locationId;
    delete (backup.appointments[0] as Record<string, unknown>).locationId;

    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });

    const { db, inserted } = restoreDb();
    await restorePracticeData(db as never, "target-practice", backup);
    const restoredRows = inserted.flatMap(({ rows }) => rows);
    expect(restoredRows.find((row) => row.id === roomId)).toMatchObject({
      practiceId: "target-practice",
      locationId,
    });
    expect(restoredRows.find((row) => row.id === appointmentId)).toMatchObject({
      practiceId: "target-practice",
      locationId,
      roomId,
    });
  });

  it("rejects legacy scheduling rows when their location is ambiguous", () => {
    const backup = schedulingBackup();
    backup.formatVersion = 4;
    backup.locations.push({
      id: otherLocationId,
      practiceId,
      name: "North Clinic",
      isPrimary: false,
      deletedAt: null,
    });
    backup.locations[0]!.isPrimary = false;
    delete (backup.rooms[0] as Record<string, unknown>).locationId;
    delete (backup.appointments[0] as Record<string, unknown>).locationId;

    const { errors } = validatePracticeExportRestore(backup);
    expect(errors).toContain(
      "rooms[room-1].locationId could not be derived; assign the room to a clinic location before restoring.",
    );
    expect(errors).toContain(
      "appointments[appointment-1].locationId could not be derived; assign the appointment to a clinic location before restoring.",
    );
  });
});

describe("exportPracticeData query scoping", () => {
  const source = readFileSync(new URL("../export.ts", import.meta.url), "utf8");

  it("retains both endpoints of immutable SOAP replacement history", () => {
    expect(source).toContain(
      "...soapNoteReplacementRows.flatMap((replacement) => [",
    );
    expect(source).toContain("replacement.sourceSoapNoteId");
    expect(source).toContain("replacement.replacementSoapNoteId");
    expect(source).toContain("public.restore_soap_note_replacement(");
  });

  it("exports parent-scoped children through active tenant parents", () => {
    const helper = source.match(
      /async function tenantParentChildRows[\s\S]+?async function restoreRows/,
    )?.[0];

    expect(helper).toContain("inArray(parentColumn, parentIds)");
    expect(helper).toContain("where ${parentIdColumn} = ${parentColumn}");
    expect(helper).toContain("and ${parentTable.practiceId} = ${practiceId}");
    expect(helper).toContain("and ${parentTable.deletedAt} is null");
    expect(helper).toContain("isNull(table.deletedAt)");
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      patientWeights",
    );
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      patientAllergies",
    );
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      invoiceItems",
    );
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      payments",
    );
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      invoiceAdjustments",
    );
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      treatmentTemplateItems",
    );
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      caseEntries",
    );
    expect(source).toContain(
      "tenantParentChildRows(\n      db,\n      treatmentPlanItems",
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

  it("exports append-only SMS consent evidence and referenced identities", () => {
    expect(source).toContain(
      "allPracticeRows(db, smsConsentEvents, practiceId)",
    );
    expect(source).toContain(
      "...smsConsentEventRows.map((event) => event.clientId)",
    );
    expect(source).toContain(
      "...smsConsentEventRows.map((event) => event.actorUserId)",
    );
    expect(source).toContain(
      "...smsConsentEventRows.map((event) => event.locationId)",
    );
    expect(source).toContain(
      "...appointmentRows.map((appointment) => appointment.locationId)",
    );
    expect(source).toContain("smsConsentEvents: smsConsentEventRows");
    expect(source).toContain(".onConflictDoNothing()");
    expect(source).toContain("restored.smsConsentEvents = await restoreRows(");
    expect(source).toContain("smsConsentRestore.smsConsentEvents");
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
      ]),
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
      ]),
    ).toEqual([{ id: "client-1", accessToken: null }]);

    expect(
      sanitizePracticeExportRows("apiKeys", [
        {
          id: "api-key-1",
          keyPrefix: "ovpm_live123",
          keyHash: "stored-api-key-hash",
          lastUsedAt: new Date("2026-06-01T12:00:00Z"),
        },
      ]),
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
      ]),
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
      ]),
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

  it("redacts platform-operator identities from exported SMS ledgers", () => {
    expect(
      sanitizePracticeExportRows("smsSendAttempts", [
        {
          id: "attempt-operator",
          requestedByActorType: "platform_operator",
          requestedByIdentity: "private-operator@example.com",
          requestedByName: "Private Operator",
        },
        {
          id: "attempt-clinic",
          requestedByActorType: "clinic_user",
          requestedByIdentity: "clinic-user-1",
          requestedByName: "Clinic User",
        },
      ]),
    ).toEqual([
      {
        id: "attempt-operator",
        requestedByActorType: "platform_operator",
        requestedByIdentity: "platform-operator",
        requestedByName: "OpenVPM operator",
      },
      {
        id: "attempt-clinic",
        requestedByActorType: "clinic_user",
        requestedByIdentity: "clinic-user-1",
        requestedByName: "Clinic User",
      },
    ]);

    for (const section of [
      "smsSendAttemptEvents",
      "smsDeliveryEventHistory",
    ] as const) {
      expect(
        sanitizePracticeExportRows(section, [
          {
            id: `${section}-operator`,
            actorType: "platform_operator",
            actorIdentity: "private-operator@example.com",
            actorName: "Private Operator",
          },
          {
            id: `${section}-clinic`,
            actorType: "clinic_user",
            actorIdentity: "clinic-user-1",
            actorName: "Clinic User",
          },
        ]),
      ).toEqual([
        {
          id: `${section}-operator`,
          actorType: "platform_operator",
          actorIdentity: "platform-operator",
          actorName: "OpenVPM operator",
        },
        {
          id: `${section}-clinic`,
          actorType: "clinic_user",
          actorIdentity: "clinic-user-1",
          actorName: "Clinic User",
        },
      ]);
    }
  });
});

describe("restorePracticeData", () => {
  it("restores immutable SOAP replacement history after later soft deletion", async () => {
    const activeBackup = validSoapReplacementBackup();
    const backup = {
      ...activeBackup,
      soapNotes: activeBackup.soapNotes.map((note, index) => ({
        ...note,
        deletedAt:
          index === 0 ? "2026-08-09T16:20:00.000Z" : "2026-08-09T16:21:00.000Z",
      })),
    };
    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });

    const { db, executed } = restoreDb([
      [
        {
          result_id: SOAP_REPLACEMENT_LINK_ID,
          was_inserted: true,
        },
      ],
    ]);
    await expect(
      restorePracticeData(db as never, backup.practiceId, backup),
    ).resolves.toMatchObject({
      restored: {
        soapNotes: 2,
        clinicalRecordCorrections: 1,
        soapNoteReplacements: 1,
      },
    });
    expect(executed).toHaveLength(1);
  });

  it("does not restore any provider-authority SMS ledger through clinic restore", async () => {
    const backup = {
      ...emptyBackup(),
      practiceId: "source-practice",
      communications: [
        {
          id: "communication-1",
          practiceId: "source-practice",
          channel: "sms",
          direction: "outbound",
          status: "sent",
        },
      ],
      smsSendAttempts: [
        {
          id: "attempt-1",
          practiceId: "source-practice",
          communicationId: "communication-1",
        },
      ],
      smsSendAttemptEvents: [
        {
          id: "attempt-event-1",
          practiceId: "source-practice",
          attemptId: "attempt-1",
          outcome: "accepted",
          providerMessageId: "provider-message-1",
        },
      ],
      smsDeliveryEvents: [{ id: "delivery-event-1" }],
      smsDeliveryEventHistory: [
        {
          id: "delivery-history-1",
          deliveryEventId: "delivery-event-1",
          practiceId: "source-practice",
          attemptId: "attempt-1",
          communicationId: "communication-1",
        },
      ],
    };
    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });

    const { db, inserted } = restoreDb();
    const result = await restorePracticeData(
      db as never,
      "target-practice",
      backup,
    );

    expect(result.restored).toMatchObject({
      communications: 1,
      smsSendAttempts: 0,
      smsSendAttemptEvents: 0,
      smsDeliveryEvents: 0,
      smsDeliveryEventHistory: 0,
    });
    const restoredIds = inserted
      .flatMap(({ rows }) => rows)
      .map((row) => row.id);
    expect(restoredIds).toContain("communication-1");
    expect(restoredIds).not.toEqual(
      expect.arrayContaining([
        "attempt-1",
        "attempt-event-1",
        "delivery-event-1",
        "delivery-history-1",
      ]),
    );
  });

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

  it("rejects unsafe provider hours before a backup restore writes", () => {
    const providerHoursBackup = () => ({
      practiceId: "practice-1",
      ...emptyBackup(),
      users: [
        {
          id: "provider-1",
          practiceId: "practice-1",
          role: "admin",
          isVeterinarian: true,
          deletedAt: null,
        },
      ],
      locations: [
        {
          id: "location-1",
          practiceId: "practice-1",
          deletedAt: null,
        },
      ],
      staffSchedules: [
        {
          id: "hours-1",
          practiceId: "practice-1",
          userId: "provider-1",
          locationId: "location-1",
          dayOfWeek: 1,
          startTime: "08:00:00",
          endTime: "12:00:00",
        },
        {
          id: "hours-2",
          practiceId: "practice-1",
          userId: "provider-1",
          locationId: "location-1",
          dayOfWeek: 1,
          startTime: "12:00:00",
          endTime: "17:00:00",
        },
      ],
    });

    expect(validatePracticeExportRestore(providerHoursBackup())).toEqual({
      valid: true,
      errors: [],
    });

    const overlapping = providerHoursBackup();
    overlapping.staffSchedules[1]!.startTime = "11:30:00";
    expect(validatePracticeExportRestore(overlapping).errors).toContain(
      "staffSchedules[hours-2] overlaps another provider working window.",
    );

    const invalidRange = providerHoursBackup();
    invalidRange.staffSchedules[0]!.endTime = "08:00:00";
    expect(validatePracticeExportRestore(invalidRange).errors).toContain(
      "staffSchedules[hours-1] must contain a valid startTime before endTime.",
    );

    const nonProvider = providerHoursBackup();
    nonProvider.users[0]!.isVeterinarian = false;
    expect(validatePracticeExportRestore(nonProvider).errors).toContain(
      "staffSchedules[hours-1].userId must reference an active veterinarian provider.",
    );

    const tooManyWindows = providerHoursBackup();
    tooManyWindows.staffSchedules = [
      ...tooManyWindows.staffSchedules,
      {
        id: "hours-3",
        practiceId: "practice-1",
        userId: "provider-1",
        locationId: "location-1",
        dayOfWeek: 1,
        startTime: "17:00:00",
        endTime: "18:00:00",
      },
      {
        id: "hours-4",
        practiceId: "practice-1",
        userId: "provider-1",
        locationId: "location-1",
        dayOfWeek: 1,
        startTime: "18:00:00",
        endTime: "19:00:00",
      },
    ];
    expect(validatePracticeExportRestore(tooManyWindows).errors).toContain(
      "staffSchedules[hours-4] exceeds the maximum of three provider working windows per day.",
    );
  });

  it("restores legacy veterinarian roles with provider capability", async () => {
    const backup = {
      practiceId: "source-practice",
      ...emptyBackup(),
      users: [
        {
          id: "legacy-vet",
          practiceId: "source-practice",
          role: "veterinarian",
        },
      ],
    };
    const { db, inserted } = restoreDb();

    await restorePracticeData(db as never, "target-practice", backup);

    expect(
      inserted
        .flatMap(({ rows }) => rows)
        .find((row) => row.id === "legacy-vet"),
    ).toMatchObject({
      practiceId: "target-practice",
      isVeterinarian: true,
    });
  });

  it("restores corrected same-encounter SOAP history and soft-deleted addendum evidence", async () => {
    const finalizedAt = "2026-08-09T15:00:00.000Z";
    const sourceAddendumContent =
      "Clarification recorded before the correction.";
    const retiredAddendumContent =
      "Evidence retained before the record was retired.";
    const backup = {
      formatVersion: 3,
      practiceId: "source-practice",
      ...emptyBackup(),
      users: [
        {
          id: SOAP_BACKUP_USER_ID,
          practiceId: "source-practice",
          name: "Dr. Rivera",
        },
      ],
      clients: [{ id: "client-1", practiceId: "source-practice" }],
      patients: [
        {
          id: "patient-1",
          practiceId: "source-practice",
          clientId: "client-1",
        },
      ],
      appointments: [
        {
          id: "appointment-1",
          practiceId: "source-practice",
          clientId: "client-1",
          patientId: "patient-1",
        },
      ],
      soapNotes: [
        {
          id: SOAP_SOURCE_ID,
          practiceId: "source-practice",
          patientId: "patient-1",
          appointmentId: "appointment-1",
          authorId: SOAP_BACKUP_USER_ID,
          authorName: "Dr. Rivera",
          status: "finalized",
          revision: 1,
          finalizedAt,
          finalizedBy: SOAP_BACKUP_USER_ID,
          finalizerName: "Dr. Rivera",
          imported: false,
          deletedAt: null,
        },
        {
          id: SOAP_REPLACEMENT_ID,
          practiceId: "source-practice",
          patientId: "patient-1",
          appointmentId: "appointment-1",
          authorId: SOAP_BACKUP_USER_ID,
          authorName: "Dr. Rivera",
          status: "finalized",
          revision: 1,
          finalizedAt,
          finalizedBy: SOAP_BACKUP_USER_ID,
          finalizerName: "Dr. Rivera",
          imported: false,
          deletedAt: null,
        },
        {
          id: SOAP_RETIRED_ID,
          practiceId: "source-practice",
          patientId: "patient-1",
          appointmentId: null,
          authorId: SOAP_BACKUP_USER_ID,
          authorName: "Dr. Rivera",
          status: "finalized",
          revision: 1,
          finalizedAt,
          finalizedBy: SOAP_BACKUP_USER_ID,
          finalizerName: "Dr. Rivera",
          imported: false,
          deletedAt: "2026-08-09T18:00:00.000Z",
        },
      ],
      soapNoteAddenda: [
        {
          id: SOAP_ADDENDUM_SOURCE_ID,
          createdAt: "2026-08-09T16:00:00.000Z",
          practiceId: "source-practice",
          soapNoteId: SOAP_SOURCE_ID,
          authorId: SOAP_BACKUP_USER_ID,
          authorName: "Dr. Rivera",
          content: sourceAddendumContent,
          operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          operationPayloadHash: soapAddendumHash(
            SOAP_SOURCE_ID,
            SOAP_BACKUP_USER_ID,
            sourceAddendumContent,
          ),
        },
        {
          id: SOAP_ADDENDUM_RETIRED_ID,
          createdAt: "2026-08-09T17:00:00.000Z",
          practiceId: "source-practice",
          soapNoteId: SOAP_RETIRED_ID,
          authorId: SOAP_BACKUP_USER_ID,
          authorName: "Dr. Rivera",
          content: retiredAddendumContent,
          operationId: "00000000-0000-4000-8000-000000000032",
          operationPayloadHash: soapAddendumHash(
            SOAP_RETIRED_ID,
            SOAP_BACKUP_USER_ID,
            retiredAddendumContent,
          ),
        },
      ],
      clinicalRecordCorrections: [
        {
          id: "correction-1",
          practiceId: "source-practice",
          recordType: "soap_note",
          action: "entered_in_error",
          soapNoteId: SOAP_SOURCE_ID,
          vitalSignId: null,
          vaccinationRecordId: null,
          labResultId: null,
          patientId: "patient-1",
          appointmentId: "appointment-1",
          correctedBy: SOAP_BACKUP_USER_ID,
          correctedByName: "Dr. Rivera",
          reason: "Documented on the wrong encounter.",
          createdAt: "2026-08-09T16:30:00.000Z",
          operationId: null,
          operationPayloadHash: null,
        },
      ],
    };
    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });

    const addendumError = (
      replacement: Record<string, unknown>,
      extra: Record<string, unknown>[] = [],
    ) =>
      validatePracticeExportRestore({
        ...backup,
        soapNoteAddenda: [
          { ...backup.soapNoteAddenda[0], ...replacement },
          backup.soapNoteAddenda[1],
          ...extra,
        ],
      }).errors;
    expect(addendumError({ createdAt: "2026-08-09T14:59:59.000Z" })).toContain(
      `soapNoteAddenda[${SOAP_ADDENDUM_SOURCE_ID}].createdAt must be on or after finalization, not in the future, and no later than source deletion or correction.`,
    );
    expect(addendumError({ createdAt: "2099-08-09T16:00:00.000Z" })).toContain(
      `soapNoteAddenda[${SOAP_ADDENDUM_SOURCE_ID}].createdAt must be on or after finalization, not in the future, and no later than source deletion or correction.`,
    );
    expect(addendumError({ createdAt: "2026-08-09T16:31:00.000Z" })).toContain(
      `soapNoteAddenda[${SOAP_ADDENDUM_SOURCE_ID}].createdAt must be on or after finalization, not in the future, and no later than source deletion or correction.`,
    );
    expect(addendumError({ operationPayloadHash: "0".repeat(64) })).toContain(
      `soapNoteAddenda[${SOAP_ADDENDUM_SOURCE_ID}].operationPayloadHash must match its exact note, author, and content payload.`,
    );
    expect(
      addendumError({
        soapNoteId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      }),
    ).toContain(
      `soapNoteAddenda[${SOAP_ADDENDUM_SOURCE_ID}].soapNoteId must be a canonical lowercase UUID.`,
    );
    expect(
      addendumError({ authorId: SOAP_BACKUP_USER_ID.replaceAll("-", "") }),
    ).toContain(
      `soapNoteAddenda[${SOAP_ADDENDUM_SOURCE_ID}].authorId must be a canonical lowercase UUID.`,
    );
    expect(addendumError({ id: "not-a-uuid" })).toContain(
      "soapNoteAddenda[not-a-uuid].id must be a canonical lowercase UUID.",
    );
    expect(
      validatePracticeExportRestore({
        ...backup,
        clinicalRecordCorrections: [
          { ...backup.clinicalRecordCorrections[0], createdAt: undefined },
        ],
      }).errors,
    ).toContain(
      `soapNoteAddenda[${SOAP_ADDENDUM_SOURCE_ID}] linked correction.createdAt must be a timestamp.`,
    );
    expect(
      validatePracticeExportRestore({
        ...backup,
        soapNotes: backup.soapNotes.map((note) =>
          note.id === SOAP_RETIRED_ID
            ? { ...note, deletedAt: "not-a-timestamp" }
            : note,
        ),
      }).errors,
    ).toContain(
      `soapNoteAddenda[${SOAP_ADDENDUM_RETIRED_ID}] source deletedAt must be a valid timestamp.`,
    );
    const duplicateContent = "Second copy with a reused operation.";
    const duplicateOperationErrors = addendumError({}, [
      {
        ...backup.soapNoteAddenda[0],
        id: "00000000-0000-4000-8000-000000000047",
        content: duplicateContent,
        operationId: String(
          backup.soapNoteAddenda[0].operationId,
        ).toUpperCase(),
        operationPayloadHash: soapAddendumHash(
          SOAP_SOURCE_ID,
          SOAP_BACKUP_USER_ID,
          duplicateContent,
        ),
      },
    ]);
    expect(duplicateOperationErrors).toContain(
      "soapNoteAddenda[00000000-0000-4000-8000-000000000047].operationId must be unique within its practice.",
    );
    expect(duplicateOperationErrors).toContain(
      "soapNoteAddenda[00000000-0000-4000-8000-000000000047].operationId must be a canonical lowercase UUID.",
    );

    const { db, inserted, executed, timeline } = restoreDb();
    await expect(
      restorePracticeData(db as never, "target-practice", backup),
    ).resolves.toMatchObject({
      restored: {
        soapNotes: 3,
        soapNoteAddenda: 2,
        clinicalRecordCorrections: 1,
      },
    });

    const restoredRows = inserted.flatMap(({ rows }) => rows);
    const correctionIndex = restoredRows.findIndex(
      (row) => row.id === "correction-1",
    );
    expect(
      restoredRows.findIndex((row) => row.id === SOAP_SOURCE_ID),
    ).toBeLessThan(correctionIndex);
    expect(
      restoredRows.findIndex((row) => row.id === SOAP_REPLACEMENT_ID),
    ).toBeLessThan(correctionIndex);
    expect(timeline.indexOf("insert:correction-1")).toBeLessThan(
      timeline.indexOf("execute"),
    );
    expect(executed).toHaveLength(2);

    const retry = restoreDb([
      [
        {
          result_id: SOAP_ADDENDUM_SOURCE_ID,
          was_inserted: false,
        },
      ],
      [
        {
          result_id: SOAP_ADDENDUM_RETIRED_ID,
          was_inserted: false,
        },
      ],
    ]);
    await expect(
      restorePracticeData(retry.db as never, "target-practice", backup),
    ).resolves.toMatchObject({ restored: { soapNoteAddenda: 0 } });
    expect(retry.executed).toHaveLength(2);
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
      vaccinationRecords: [
        {
          id: "vaccination-1",
          patientId: "patient-1",
          appointmentId: "appointment-1",
          administeredBy: "user-1",
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
        {
          id: "correction-3",
          recordType: "vaccination_record",
          soapNoteId: null,
          vitalSignId: null,
          vaccinationRecordId: "vaccination-1",
          patientId: "patient-1",
          appointmentId: "appointment-1",
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
      }).errors,
    ).toContain(
      "clinicalRecordCorrections[correction-1] must match its source record patientId and appointmentId exactly.",
    );

    expect(
      validatePracticeExportRestore({
        ...backup,
        clinicalRecordCorrections: [
          {
            ...backup.clinicalRecordCorrections[0],
            recordType: "unexpected",
          },
        ],
      }).errors,
    ).toContain(
      "clinicalRecordCorrections[correction-1].recordType must be soap_note, vital_sign, vaccination_record, or lab_result.",
    );

    expect(
      validatePracticeExportRestore({
        ...backup,
        clinicalRecordCorrections: [
          {
            ...backup.clinicalRecordCorrections[2],
            patientId: "patient-2",
            appointmentId: "appointment-2",
          },
        ],
      }).errors,
    ).toContain(
      "clinicalRecordCorrections[correction-3] must match its source record patientId and appointmentId exactly.",
    );

    expect(
      validatePracticeExportRestore({
        ...backup,
        clinicalRecordCorrections: [
          backup.clinicalRecordCorrections[2],
          {
            ...backup.clinicalRecordCorrections[2],
            id: "correction-4",
          },
        ],
      }).errors,
    ).toContain(
      "clinicalRecordCorrections[correction-4] duplicates an existing correction source.",
    );
  });

  it("validates exact append-only lab replacement chains", () => {
    const backup = validLabReplacementBackup();
    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });

    expect(
      validatePracticeExportRestore({
        ...backup,
        labResultReplacements: [
          ...backup.labResultReplacements,
          {
            ...backup.labResultReplacements[0],
            id: "replacement-link-duplicate",
            operationId: "00000000-0000-4000-8000-000000000025",
          },
        ],
      }).errors,
    ).toContain(
      "labResultReplacements[replacement-link-duplicate].sourceLabResultId must be unique within its practice.",
    );

    expect(
      validatePracticeExportRestore({
        ...backup,
        labResultReplacements: [
          {
            ...backup.labResultReplacements[0],
            correctionId: "correction-2",
          },
        ],
      }).errors,
    ).toContain(
      "labResultReplacements[replacement-link-1].correctionId must identify the exact lab correction for its source.",
    );

    expect(
      validatePracticeExportRestore({
        ...backup,
        labResultReplacements: [
          backup.labResultReplacements[0],
          {
            ...backup.labResultReplacements[1],
            replacementLabResultId: "lab-1",
          },
        ],
      }).errors,
    ).toContain(
      'labResultReplacements contains a directed replacement cycle at lab result "lab-1".',
    );

    expect(
      validatePracticeExportRestore({
        ...backup,
        labResults: backup.labResults.map((row) =>
          row.id === "lab-3" ? { ...row, practiceId: "practice-2" } : row,
        ),
      }).errors,
    ).toContain(
      "labResultReplacements[replacement-link-2].practiceId must match all linked evidence.",
    );
  });

  it("validates exact immutable SOAP replacement evidence", () => {
    const backup = validSoapReplacementBackup();
    expect(validatePracticeExportRestore(backup)).toEqual({
      valid: true,
      errors: [],
    });

    const missingCorrectionErrors = validatePracticeExportRestore({
      ...backup,
      soapNoteReplacements: [
        {
          ...backup.soapNoteReplacements[0],
          correctionId: "00000000-0000-4000-8000-000000000099",
        },
      ],
    }).errors;
    expect(missingCorrectionErrors.length).toBeGreaterThan(0);

    expect(
      validatePracticeExportRestore({
        ...backup,
        soapNoteReplacements: [
          {
            ...backup.soapNoteReplacements[0],
            operationPayloadHash: "b".repeat(64),
          },
        ],
      }).errors,
    ).toContain(
      `soapNoteReplacements[${SOAP_REPLACEMENT_LINK_ID}].operationPayloadHash must match its exact correction and replacement payload.`,
    );

    const deletedHistory = {
      ...backup,
      soapNotes: backup.soapNotes.map((note, index) => ({
        ...note,
        deletedAt:
          index === 0 ? "2026-08-09T16:20:00.000Z" : "2026-08-09T16:21:00.000Z",
      })),
    };
    expect(validatePracticeExportRestore(deletedHistory)).toEqual({
      valid: true,
      errors: [],
    });

    expect(
      validatePracticeExportRestore({
        ...deletedHistory,
        soapNotes: deletedHistory.soapNotes.map((note, index) =>
          index === 1
            ? { ...note, deletedAt: "2026-08-09T16:14:59.000Z" }
            : note,
        ),
      }).errors,
    ).toContain(
      `soapNoteReplacements[${SOAP_REPLACEMENT_LINK_ID}] chronology must run from source finalization through correction, replacement finalization, link creation, and any later replacement correction.`,
    );

    expect(
      validatePracticeExportRestore({
        ...backup,
        clinicalRecordCorrections: backup.clinicalRecordCorrections.map(
          (correction) => ({
            ...correction,
            createdAt: "2026-08-09T16:11:00.000Z",
          }),
        ),
      }).errors,
    ).toContain(
      `soapNoteReplacements[${SOAP_REPLACEMENT_LINK_ID}] chronology must run from source finalization through correction, replacement finalization, link creation, and any later replacement correction.`,
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
      "soapNotes[soap-1].appointmentId must reference an appointment for the same patient.",
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
      'appointments[appointment-1].clientId references missing clients row "other-client".',
    );

    await expect(
      restorePracticeData(db as never, "target-practice", backup),
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
    ).rejects.toThrow(
      "Backup is missing required sections: prescriptionEvents",
    );
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
      ]),
    );

    await expect(
      restorePracticeData(db as never, "target-practice", backup),
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
      "2026-07-01T12:00:00.000Z",
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

  it("normalizes legacy lab lifecycle shapes fail-safe during restore", async () => {
    const timestamp = "2026-07-01T12:00:00.000Z";
    const backup = {
      ...emptyBackup(),
      users: [{ id: "user-1", practiceId: "source-practice" }],
      clients: [{ id: "client-1", practiceId: "source-practice" }],
      patients: [
        {
          id: "patient-1",
          practiceId: "source-practice",
          clientId: "client-1",
        },
      ],
      labResults: [
        {
          id: "lab-pending-with-value",
          practiceId: "source-practice",
          patientId: "patient-1",
          status: "pending",
          resultValue: "12.5",
          unit: "mg/dL",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "lab-empty-pending",
          practiceId: "source-practice",
          patientId: "patient-1",
          status: "pending",
          resultValue: null,
          unit: "mg/dL",
          referenceRangeLow: "1",
          referenceRangeHigh: "2",
          resultFlag: "abnormal",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "lab-pending-with-follow-up",
          practiceId: "source-practice",
          patientId: "patient-1",
          status: "pending",
          resultValue: null,
          followUpStatus: "open",
          followUpAssignedTo: "user-1",
          followUpDueAt: timestamp,
          followUpNote: "Legacy assignment before values existed.",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "lab-critical-open-without-due",
          practiceId: "source-practice",
          patientId: "patient-1",
          status: "completed",
          resultValue: "2.1",
          resultFlag: "critical",
          followUpStatus: "open",
          followUpAssignedTo: "user-1",
          followUpNote: "Call the owner.",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "lab-critical-completed-without-due",
          practiceId: "source-practice",
          patientId: "patient-1",
          status: "reviewed",
          resultValue: "2.2",
          resultFlag: "critical",
          reviewedBy: "user-1",
          followUpStatus: "completed",
          followUpAssignedTo: "user-1",
          followUpCompletedBy: "user-1",
          followUpCompletedAt: timestamp,
          followUpOutcome: "Owner reached.",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "lab-unattributed-review",
          practiceId: "source-practice",
          patientId: "patient-1",
          status: "reviewed",
          resultValue: "8.1",
          reviewedBy: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "lab-attributed-review",
          practiceId: "source-practice",
          patientId: "patient-1",
          status: "reviewed",
          resultValue: "9.1",
          reviewedBy: "user-1",
          followUpStatus: "completed",
          followUpAssignedTo: "user-1",
          followUpCompletedBy: "user-1",
          followUpCompletedAt: timestamp,
          followUpOutcome: "Owner reached and repeat testing arranged.",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      labResultEvents: [
        {
          id: "lab-created-event",
          practiceId: "source-practice",
          labResultId: "lab-attributed-review",
          patientId: "patient-1",
          appointmentId: undefined,
          eventType: "created",
          statusBefore: null,
          statusAfter: "pending",
          resultValue: null,
          unit: null,
          referenceRangeLow: null,
          referenceRangeHigh: null,
          resultFlag: "unknown",
          followUpStatus: "not_required",
          actorId: "user-1",
          actorName: "Clinician",
          operationId: "00000000-0000-4000-8000-000000000095",
          operationPayloadHash: "1".repeat(64),
          createdAt: timestamp,
        },
        {
          id: "lab-completed-event",
          practiceId: "source-practice",
          labResultId: "lab-attributed-review",
          patientId: "patient-1",
          appointmentId: undefined,
          eventType: "completed",
          statusBefore: "pending",
          statusAfter: "completed",
          resultValue: "9.1",
          unit: "mg/dL",
          referenceRangeLow: "8.000",
          referenceRangeHigh: "18.000",
          resultFlag: "normal",
          followUpStatus: "not_required",
          actorId: "user-1",
          actorName: "Clinician",
          operationId: "00000000-0000-4000-8000-000000000096",
          operationPayloadHash: "2".repeat(64),
          createdAt: timestamp,
        },
        {
          id: "lab-review-event",
          practiceId: "source-practice",
          labResultId: "lab-attributed-review",
          patientId: "patient-1",
          appointmentId: undefined,
          eventType: "reviewed",
          statusBefore: "completed",
          statusAfter: "reviewed",
          resultValue: "9.1",
          unit: "mg/dL",
          referenceRangeLow: "8.000",
          referenceRangeHigh: "18.000",
          resultFlag: "normal",
          followUpStatus: "not_required",
          actorId: "user-1",
          actorName: "Clinician",
          operationId: "00000000-0000-4000-8000-000000000099",
          operationPayloadHash: "3".repeat(64),
          createdAt: timestamp,
        },
        {
          id: "lab-follow-up-event",
          practiceId: "source-practice",
          labResultId: "lab-attributed-review",
          patientId: "patient-1",
          appointmentId: undefined,
          eventType: "follow_up_assigned",
          statusBefore: "reviewed",
          statusAfter: "reviewed",
          resultValue: "9.1",
          unit: "mg/dL",
          referenceRangeLow: "8.000",
          referenceRangeHigh: "18.000",
          resultFlag: "normal",
          followUpStatus: "open",
          followUpAssignedTo: "user-1",
          actorId: "user-1",
          actorName: "Clinician",
          note: "Call the owner and arrange repeat testing.",
          operationId: "00000000-0000-4000-8000-000000000098",
          operationPayloadHash: "4".repeat(64),
          createdAt: timestamp,
        },
        {
          id: "lab-follow-up-completed-event",
          practiceId: "source-practice",
          labResultId: "lab-attributed-review",
          patientId: "patient-1",
          appointmentId: undefined,
          eventType: "follow_up_completed",
          statusBefore: "reviewed",
          statusAfter: "reviewed",
          resultValue: "9.1",
          unit: "mg/dL",
          referenceRangeLow: "8.000",
          referenceRangeHigh: "18.000",
          resultFlag: "normal",
          followUpStatus: "completed",
          followUpAssignedTo: "user-1",
          actorId: "user-1",
          actorName: "Clinician",
          note: "Owner reached and repeat testing arranged.",
          operationId: "00000000-0000-4000-8000-000000000097",
          operationPayloadHash: "5".repeat(64),
          createdAt: timestamp,
        },
      ],
    };
    const { db, inserted } = restoreDb();

    await restorePracticeData(db as never, "target-practice", backup);
    const rows = inserted.flatMap(({ rows: batch }) => batch);
    const row = (id: string) => rows.find((candidate) => candidate.id === id);

    expect(row("lab-pending-with-value")).toMatchObject({
      status: "completed",
      resultValue: "12.5",
      completedAt: new Date(timestamp),
      reviewedAt: null,
      reviewedBy: null,
    });
    expect(row("lab-empty-pending")).toMatchObject({
      status: "pending",
      resultValue: null,
      unit: null,
      referenceRangeLow: null,
      referenceRangeHigh: null,
      resultFlag: "unknown",
      completedAt: null,
      reviewedAt: null,
      reviewedBy: null,
    });
    expect(row("lab-pending-with-follow-up")).toMatchObject({
      status: "pending",
      followUpStatus: "not_required",
      followUpAssignedTo: null,
      followUpDueAt: null,
      followUpNote: null,
    });
    expect(row("lab-critical-open-without-due")).toMatchObject({
      status: "completed",
      followUpStatus: "not_required",
      followUpAssignedTo: null,
      followUpDueAt: null,
      followUpNote: null,
    });
    expect(row("lab-critical-completed-without-due")).toMatchObject({
      status: "completed",
      reviewedAt: null,
      reviewedBy: null,
      followUpStatus: "not_required",
      followUpAssignedTo: null,
      followUpDueAt: null,
      followUpCompletedBy: null,
      followUpCompletedAt: null,
      followUpOutcome: null,
    });
    expect(row("lab-unattributed-review")).toMatchObject({
      status: "completed",
      completedAt: new Date(timestamp),
      reviewedAt: null,
      reviewedBy: null,
    });
    expect(row("lab-attributed-review")).toMatchObject({
      status: "reviewed",
      completedAt: new Date(timestamp),
      reviewedAt: new Date(timestamp),
      reviewedBy: "user-1",
    });
    expect(row("lab-review-event")).toMatchObject({
      eventType: "reviewed",
      resultValue: "9.1",
      unit: "mg/dL",
      referenceRangeLow: "8.000",
      referenceRangeHigh: "18.000",
      actorName: "Clinician",
    });
    expect(
      rows.filter(
        (candidate) =>
          typeof candidate.id === "string" &&
          candidate.id.startsWith("lab-") &&
          candidate.id.endsWith("event"),
      ),
    ).toHaveLength(5);
    expect(row("lab-created-event")).toMatchObject({
      statusAfter: "pending",
      resultValue: null,
      resultFlag: "unknown",
    });
    expect(row("lab-follow-up-completed-event")).toMatchObject({
      statusAfter: "reviewed",
      resultValue: "9.1",
      followUpStatus: "completed",
      note: "Owner reached and repeat testing arranged.",
    });
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
      backup,
    );
    const restoredRows = inserted.flatMap(({ rows }) => rows);

    expect(rootDb.transaction).toHaveBeenCalledTimes(1);
    expect(result.totalRows).toBe(1);
    expect(restoredRows).toContainEqual(
      expect.objectContaining({
        id: "client-1",
        practiceId: "target-practice",
      }),
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
      smsConsentEvents: [
        {
          id: "sms-consent-event-1",
          practiceId: "source-practice",
          clientId: "client-1",
          locationId: "location-1",
          destinationE164: "+15555550100",
          action: "granted",
          source: "staff_attested_form:v1",
          disclosureVersion: "v1",
          disclosure: "Exact historical disclosure",
          actorType: "staff",
          actorUserId: "user-1",
          actorName: "Ada Staff",
          eventKey: "staff:historical-1",
          occurredAt: "2026-08-01T12:00:00.000Z",
          createdAt: "2026-08-01T12:00:01.000Z",
        },
      ],
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

    const result = await restorePracticeData(
      db as never,
      "target-practice",
      backup,
    );
    const restoredRows = inserted.flatMap(({ rows }) => rows);

    expect(result.totalRows).toBe(19);
    expect(restoredRows.find((row) => row.id === "location-1")).toMatchObject({
      id: "location-1",
      practiceId: "target-practice",
    });
    expect(
      restoredRows.find((row) => row.id === "location-messaging-1"),
    ).toMatchObject({
      id: "location-messaging-1",
      practiceId: "target-practice",
    });
    expect(
      restoredRows.find((row) => row.id === "suppression-1"),
    ).toMatchObject({
      id: "suppression-1",
      practiceId: "target-practice",
    });
    expect(
      restoredRows.find((row) => row.id === "email-suppression-1"),
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
    expect(
      restoredRows.find((row) => row.id === "sms-consent-event-1"),
    ).toMatchObject({
      id: "sms-consent-event-1",
      practiceId: "target-practice",
      clientId: "client-1",
      locationId: "location-1",
      destinationE164: "+15555550100",
      disclosure: "Exact historical disclosure",
      eventKey: "staff:historical-1",
      occurredAt: new Date("2026-08-01T12:00:00.000Z"),
      createdAt: new Date("2026-08-01T12:00:01.000Z"),
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
      restoredRows.find((row) => row.id === "wellness-plan-1"),
    ).toMatchObject({
      id: "wellness-plan-1",
      practiceId: "target-practice",
    });
    expect(
      restoredRows.find((row) => row.id === "wellness-enrollment-1"),
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
      }),
    ).rejects.toThrow("Backup is missing required sections");
  });
});
