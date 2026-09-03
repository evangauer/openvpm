#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_CATALOG_BYTES = 1_000_000;
const MAX_BACKUP_BYTES = 50_000_000;
const SUPPORTED_EXPORT_FORMAT_VERSION = 9;
const PRACTICE_EXPORT_SECTIONS = [
  "locations",
  "locationMessaging",
  "smsSuppressions",
  "smsConsentEvents",
  "smsDeliveryEvents",
  "smsDeliveryEventHistory",
  "smsSendAttempts",
  "smsSendAttemptEvents",
  "emailSuppressions",
  "webhooks",
  "apiKeys",
  "users",
  "auditLog",
  "appointmentTypes",
  "rooms",
  "recurringSeries",
  "clients",
  "clientContacts",
  "patients",
  "patientMergeEvents",
  "insurancePolicies",
  "wellnessPlans",
  "wellnessEnrollments",
  "patientWeights",
  "patientAllergies",
  "careReminders",
  "appointments",
  "historicalAppointments",
  "appointmentWaitlist",
  "staffSchedules",
  "services",
  "products",
  "treatmentTemplates",
  "treatmentTemplateItems",
  "suppliers",
  "purchaseOrders",
  "invoices",
  "invoiceItems",
  "payments",
  "invoiceAdjustments",
  "insuranceClaims",
  "soapNotes",
  "soapNoteAddenda",
  "soapNoteReplacements",
  "vaccinationRecords",
  "labResults",
  "labResultEvents",
  "externalLabReports",
  "externalLabObservations",
  "procedures",
  "clinicalNotes",
  "problemList",
  "vitalSigns",
  "clinicalRecordCorrections",
  "labResultReplacements",
  "cases",
  "caseEntries",
  "treatmentPlans",
  "treatmentPlanItems",
  "prescriptions",
  "prescriptionEvents",
  "externalPrescriptions",
  "externalPrescriptionFills",
  "legacyFinancialDocuments",
  "legacyFinancialLineItems",
  "legacyFinancialPayments",
  "legacyFinancialAllocations",
  "dispenseChargeQueue",
  "visitCloseouts",
  "consentForms",
  "files",
  "signedConsentEvidence",
  "visitTreatmentPlans",
  "visitTreatmentPlanRevisions",
  "visitTreatmentPlanRevisionLines",
  "visitTreatmentPlanResponses",
  "visitTreatmentPlanResponseLines",
  "historicalDocuments",
  "controlledSubstanceLog",
  "communications",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredExactVersionId(value, label) {
  const versionId = requiredString(value, label).trim();
  if (versionId.toLowerCase() === "null") {
    throw new Error(`${label} must identify a versioned object`);
  }
  return versionId;
}

function readBoundedFile(path, maxBytes, label) {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte verification limit`);
  }
  return readFileSync(path);
}

function parseJson(body, label) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateCanonicalCounts(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const missing = PRACTICE_EXPORT_SECTIONS.filter(
    (section) => !Object.hasOwn(value, section),
  );
  const unsupported = keys.filter(
    (section) => !PRACTICE_EXPORT_SECTIONS.includes(section),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing canonical sections: ${missing.join(", ")}`,
    );
  }
  if (unsupported.length > 0) {
    throw new Error(
      `${label} contains unsupported sections: ${unsupported.join(", ")}`,
    );
  }
  for (const section of PRACTICE_EXPORT_SECTIONS) {
    const count = value[section];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label} contains an invalid section count`);
    }
  }
  return value;
}

function countsMatch(left, right) {
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export function verifyBackupEvidence(input) {
  const catalogBody = readBoundedFile(
    input.catalogPath,
    MAX_CATALOG_BYTES,
    "catalog",
  );
  const catalogChecksumSha256 = sha256(catalogBody);
  const catalog = parseJson(catalogBody, "catalog");

  if (catalog.catalogFormatVersion !== 2) {
    throw new Error("catalogFormatVersion must be 2");
  }
  const practiceId = requiredString(catalog.practiceId, "practiceId");
  if (!UUID_PATTERN.test(practiceId)) {
    throw new Error("practiceId must be a UUID");
  }
  const backupDate = requiredString(catalog.backupDate, "backupDate");
  const parsedBackupDate = new Date(`${backupDate}T00:00:00.000Z`);
  if (
    !DATE_PATTERN.test(backupDate) ||
    Number.isNaN(parsedBackupDate.valueOf()) ||
    parsedBackupDate.toISOString().slice(0, 10) !== backupDate
  ) {
    throw new Error("backupDate must use YYYY-MM-DD");
  }
  const exportedAt = requiredString(catalog.exportedAt, "exportedAt");
  const parsedExportedAt = new Date(exportedAt);
  if (
    Number.isNaN(parsedExportedAt.valueOf()) ||
    parsedExportedAt.toISOString() !== exportedAt
  ) {
    throw new Error("exportedAt must be an ISO timestamp");
  }
  const objectKey = requiredString(catalog.objectKey, "objectKey");
  const checksumSha256 = requiredString(
    catalog.checksumSha256,
    "checksumSha256",
  );
  if (!SHA256_PATTERN.test(checksumSha256)) {
    throw new Error("checksumSha256 must be a lowercase SHA-256 digest");
  }
  if (
    !Number.isSafeInteger(catalog.fileSizeBytes) ||
    catalog.fileSizeBytes < 0
  ) {
    throw new Error("fileSizeBytes must be a non-negative integer");
  }
  if (catalog.fileSizeBytes > MAX_BACKUP_BYTES) {
    throw new Error("cataloged backup exceeds the supported 50 MB restore cap");
  }
  if (catalog.exportFormatVersion !== SUPPORTED_EXPORT_FORMAT_VERSION) {
    throw new Error(
      `exportFormatVersion must be ${SUPPORTED_EXPORT_FORMAT_VERSION}`,
    );
  }
  const counts = validateCanonicalCounts(catalog.counts, "catalog counts");
  const objectVersionId = requiredExactVersionId(
    catalog.objectVersionId,
    "objectVersionId",
  );
  const expectedObjectKey =
    `database-backups/v2/${practiceId}/${backupDate}/` +
    `${checksumSha256}.json`;
  if (objectKey !== expectedObjectKey) {
    throw new Error(
      "objectKey does not match its practice, date, and checksum",
    );
  }

  const expectedCatalogKey =
    `database-backup-catalog/v2/${practiceId}/${backupDate}/` +
    `${catalogChecksumSha256}.json`;
  if (input.catalogKey !== expectedCatalogKey) {
    throw new Error("catalog key does not match its content checksum");
  }
  if (input.expectedPractice && input.expectedPractice !== practiceId) {
    throw new Error("catalog practice does not match --expected-practice");
  }
  if (input.expectedDate && input.expectedDate !== backupDate) {
    throw new Error("catalog date does not match --expected-date");
  }

  const objectBody = readBoundedFile(
    input.objectPath,
    MAX_BACKUP_BYTES,
    "backup object",
  );
  if (objectBody.byteLength !== catalog.fileSizeBytes) {
    throw new Error("backup object byte length does not match the catalog");
  }
  if (sha256(objectBody) !== checksumSha256) {
    throw new Error("backup object checksum does not match the catalog");
  }

  const backup = parseJson(objectBody, "backup object");
  if (backup.practiceId !== practiceId) {
    throw new Error("backup object practiceId does not match the catalog");
  }
  if (backup.exportedAt !== exportedAt) {
    throw new Error("backup object exportedAt does not match the catalog");
  }
  if (backup.formatVersion !== catalog.exportFormatVersion) {
    throw new Error("backup object formatVersion does not match the catalog");
  }
  if (backup.formatVersion !== SUPPORTED_EXPORT_FORMAT_VERSION) {
    throw new Error(
      `backup object formatVersion must be ${SUPPORTED_EXPORT_FORMAT_VERSION}`,
    );
  }
  const backupCounts = validateCanonicalCounts(backup.counts, "backup counts");
  if (!countsMatch(counts, backupCounts)) {
    throw new Error("backup object counts do not match the catalog");
  }
  for (const section of PRACTICE_EXPORT_SECTIONS) {
    if (!Array.isArray(backup[section])) {
      throw new Error(`backup object section ${section} must be an array`);
    }
    if (backup[section].length !== backupCounts[section]) {
      throw new Error(
        `backup object count for ${section} does not match its actual rows`,
      );
    }
  }

  return {
    status: "artifact_integrity_verified",
    verificationScope: "artifact_integrity_and_canonical_counts",
    applicationRestoreValidationPerformed: false,
    restorePerformed: false,
    practiceId,
    backupDate,
    exportedAt,
    catalogKey: input.catalogKey,
    catalogChecksumSha256,
    objectKey,
    objectVersionId,
    objectEtag:
      typeof catalog.objectEtag === "string" && catalog.objectEtag.trim()
        ? catalog.objectEtag
        : null,
    checksumSha256,
    fileSizeBytes: catalog.fileSizeBytes,
    exportFormatVersion: catalog.exportFormatVersion,
    counts,
    localFiles: {
      catalog: basename(input.catalogPath),
      object: basename(input.objectPath),
    },
  };
}

function usage() {
  return [
    "Usage:",
    "  pnpm backup:verify-evidence -- --catalog <catalog.json> --catalog-key <s3-key> --object <backup.json> [--expected-practice <uuid>] [--expected-date <YYYY-MM-DD>]",
    "",
    "This is an offline artifact-integrity check. It performs no restore, full application restore validation, or network calls.",
    "Download the catalog by its exact provider version before running it.",
  ].join("\n");
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const allowed = new Set([
    "--catalog",
    "--catalog-key",
    "--object",
    "--expected-practice",
    "--expected-date",
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || !value || value.startsWith("--")) {
      throw new Error(`invalid argument near ${flag ?? "end of command"}`);
    }
    values[flag] = value;
  }
  return {
    catalogPath: requiredString(values["--catalog"], "--catalog"),
    catalogKey: requiredString(values["--catalog-key"], "--catalog-key"),
    objectPath: requiredString(values["--object"], "--object"),
    expectedPractice: values["--expected-practice"],
    expectedDate: values["--expected-date"],
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  try {
    const input = parseArgs(process.argv.slice(2));
    if (input.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      process.stdout.write(
        `${JSON.stringify(verifyBackupEvidence(input), null, 2)}\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Backup evidence verification failed: ${message}\n`);
    process.exitCode = 1;
  }
}
