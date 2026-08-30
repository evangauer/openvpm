const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_AGE_MS = 15 * 60 * 1000;

type RecordValue = Record<string, unknown>;

export const CLINICAL_DATA_AUDIT_SCHEMAS = {
  controlledSubstances: {
    findingFields: ["findings"],
    countFields: [
      "totalEntries",
      "practicesWithEntries",
      "knownRepositoryDemoEntries",
      "entriesOutsideKnownRepositoryDemo",
      "nonPositiveQuantity",
      "administeredWithoutPatient",
      "wasteWithoutWitness",
      "selfWitnessed",
      "crossTenantPatient",
      "crossTenantPerformer",
      "crossTenantWitness",
      "negativeFinalBalances",
      "negativeRunningBalanceEntries",
    ],
  },
  prescriptions: {
    findingFields: ["findings", "architectureFindings"],
    countFields: [
      "totalPrescriptions",
      "practicesWithPrescriptions",
      "knownRepositoryDemoPrescriptions",
      "prescriptionsOutsideKnownRepositoryDemo",
      "nullOperationIds",
      "blankClinicalFields",
      "nonPositiveQuantities",
      "inventoryLinksWithoutPositiveQuantity",
      "negativeRefills",
      "endBeforeStart",
      "crossTenantPatients",
      "crossTenantProducts",
      "crossTenantPrescribers",
      "crossTenantAppointments",
      "missingCreatedEvents",
      "prescriptionEventSourceMismatches",
      "currentRefillProjectionMismatches",
      "terminalProjectionMismatches",
      "nonCreatedEventsWithoutOperationIds",
      "interactionCatalogRows",
      "activeAllergyRows",
    ],
  },
  labResults: {
    findingFields: [
      "integrityFindings",
      "operationalFindings",
      "architectureFindings",
    ],
    countFields: [
      "totalLabResults",
      "practicesWithLabResults",
      "knownRepositoryDemoLabResults",
      "labResultsOutsideKnownRepositoryDemo",
      "missingCreationIdentity",
      "malformedCreationIdentity",
      "blankTestNames",
      "lifecycleShapeMismatches",
      "resultShapeMismatches",
      "invertedReferenceRanges",
      "followUpShapeMismatches",
      "crossTenantPatients",
      "crossTenantAppointments",
      "crossTenantOrderers",
      "crossTenantReviewers",
      "crossTenantFollowUpAssignees",
      "crossTenantFollowUpCompleters",
      "missingCreatedEvents",
      "createdIdentityMismatches",
      "eventSourceMismatches",
      "latestEventProjectionMismatches",
      "replacementChartMismatches",
      "correctedSourcesWithoutReplacement",
      "criticalAwaitingReview",
      "overdueOpenFollowUps",
      "agedPendingOverSevenDays",
      "completedAwaitingReviewOverOneDay",
    ],
    architectureFields: [
      "appRoleExists",
      "appRoleCanDeleteLabResults",
      "appRoleCanUpdateTestName",
      "replacementChartIdentityEnforced",
    ],
  },
  vaccinations: {
    findingFields: [
      "integrityFindings",
      "operationalFindings",
      "architectureFindings",
    ],
    countFields: [
      "totalVaccinations",
      "practicesWithVaccinations",
      "knownRepositoryDemoVaccinations",
      "vaccinationsOutsideKnownRepositoryDemo",
      "correctedVaccinations",
      "blankVaccineNames",
      "nonImportVaccinationsWithoutAdministrator",
      "crossTenantPatients",
      "crossTenantAppointments",
      "appointmentPatientMismatches",
      "crossTenantAdministrators",
      "crossTenantSupervisors",
      "productExpiredBeforeAdministration",
      "nextDueNotAfterAdministration",
      "futureAdministrationTimes",
      "duplicateActiveRabiesTagAssignments",
      "certificateDetailUpdatesWithoutAuditEvidence",
      "activeRabiesVaccinations",
      "rabiesRecordsMissingCertificateData",
    ],
    architectureFields: [
      "certificateSchemaPresent",
      "appRoleExists",
      "appRoleCanDeleteVaccinations",
      "appRoleCanUpdatePatientId",
      "appRoleCanUpdateVaccineName",
      "appRoleCanUpdateAdministeredAt",
      "appRoleCanUpdateNextDueDate",
      "appRoleCanUpdateCertificateDetails",
      "appRoleCanInsertSystemIdentity",
      "certificateAuditEvidenceImmutable",
      "appAuditSystemFieldsDatabaseGenerated",
      "certificateUpdatesAreDatabaseAudited",
    ],
  },
} as const;

export type ClinicalDataIntegrityDecision = {
  ready: boolean;
  releaseSha: string | null;
  databaseTargetFingerprint: string | null;
  reasons: string[];
};

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function parsedTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireFreshTimestamp(
  reasons: string[],
  label: string,
  value: unknown,
  nowMs: number,
): number | null {
  const parsed = parsedTimestamp(value);
  if (parsed == null) {
    reasons.push(`${label} timestamp is missing or invalid.`);
    return null;
  }
  if (parsed > nowMs + 60_000) {
    reasons.push(`${label} timestamp is in the future.`);
  } else if (nowMs - parsed > MAX_AGE_MS) {
    reasons.push(`${label} evidence is stale.`);
  }
  return parsed;
}

function hasExactKeys(value: RecordValue, requiredKeys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const required = [...requiredKeys].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function validAggregateCounts(
  value: unknown,
  requiredKeys: readonly string[],
): boolean {
  const counts = record(value);
  return Boolean(
    counts &&
    hasExactKeys(counts, requiredKeys) &&
    Object.values(counts).every(
      (count) =>
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
    ),
  );
}

function validArchitectureState(
  value: unknown,
  requiredKeys: readonly string[],
): boolean {
  const state = record(value);
  return Boolean(
    state &&
    hasExactKeys(state, requiredKeys) &&
    Object.values(state).every((item) => typeof item === "boolean"),
  );
}

export function evaluateClinicalDataIntegrityEvidence(
  input: unknown,
  nowMs = Date.now(),
): ClinicalDataIntegrityDecision {
  const reasons: string[] = [];
  const root = record(input);
  if (root?.evidenceFormatVersion !== 1) {
    reasons.push("Clinical-data integrity evidence format version must be 1.");
  }
  const releaseSha =
    typeof root?.releaseSha === "string" && SHA_PATTERN.test(root.releaseSha)
      ? root.releaseSha.toLowerCase()
      : null;
  if (!releaseSha) {
    reasons.push(
      "Clinical-data integrity evidence requires an exact release SHA.",
    );
  }
  const databaseTargetFingerprint =
    typeof root?.databaseTargetFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(root.databaseTargetFingerprint)
      ? root.databaseTargetFingerprint.toLowerCase()
      : null;
  if (!databaseTargetFingerprint) {
    reasons.push(
      "Clinical-data integrity evidence requires a database target fingerprint.",
    );
  }
  if (
    root &&
    !hasExactKeys(root, [
      "evidenceFormatVersion",
      "releaseSha",
      "collectedAt",
      "databaseTargetFingerprint",
      "audits",
    ])
  ) {
    reasons.push("Clinical-data integrity evidence has unexpected fields.");
  }
  const collectedAt = requireFreshTimestamp(
    reasons,
    "Clinical-data integrity collection",
    root?.collectedAt,
    nowMs,
  );

  const audits = record(root?.audits);
  if (!audits) {
    reasons.push("Clinical-data integrity audit reports are missing.");
  } else if (!hasExactKeys(audits, Object.keys(CLINICAL_DATA_AUDIT_SCHEMAS))) {
    reasons.push("Clinical-data integrity audit report set is invalid.");
  }

  for (const [domain, schema] of Object.entries(CLINICAL_DATA_AUDIT_SCHEMAS)) {
    const label = domain.replace(/([A-Z])/g, " $1").toLowerCase();
    const audit = record(audits?.[domain]);
    if (!audit) {
      reasons.push(`Clinical-data audit ${label} is missing.`);
      continue;
    }
    if (audit.version !== 1 || audit.mode !== "read_only_aggregate") {
      reasons.push(`Clinical-data audit ${label} has an invalid format.`);
    }
    const allowedAuditFields = [
      "version",
      "mode",
      "checkedAt",
      "databaseTargetFingerprint",
      "counts",
      "releaseSafe",
      ...schema.findingFields,
      ...("architectureFields" in schema ? ["architectureState"] : []),
    ];
    if (!hasExactKeys(audit, allowedAuditFields)) {
      reasons.push(`Clinical-data audit ${label} has unexpected fields.`);
    }
    const auditTimestamp = requireFreshTimestamp(
      reasons,
      `Clinical-data audit ${label}`,
      audit.checkedAt,
      nowMs,
    );
    if (
      auditTimestamp != null &&
      collectedAt != null &&
      auditTimestamp > collectedAt + 60_000
    ) {
      reasons.push(
        `Clinical-data audit ${label} was created after collection.`,
      );
    }
    if (
      !databaseTargetFingerprint ||
      typeof audit.databaseTargetFingerprint !== "string" ||
      audit.databaseTargetFingerprint.toLowerCase() !==
        databaseTargetFingerprint
    ) {
      reasons.push(
        `Clinical-data audit ${label} does not match the database target.`,
      );
    }
    if (!validAggregateCounts(audit.counts, schema.countFields)) {
      reasons.push(
        `Clinical-data audit ${label} has invalid aggregate counts.`,
      );
    }
    if (
      (domain === "labResults" || domain === "vaccinations") &&
      !validArchitectureState(
        audit.architectureState,
        "architectureFields" in schema ? schema.architectureFields : [],
      )
    ) {
      reasons.push(
        `Clinical-data audit ${label} has invalid architecture state.`,
      );
    }
    for (const field of schema.findingFields) {
      const findings = audit[field];
      if (
        !Array.isArray(findings) ||
        !findings.every((finding) => typeof finding === "string")
      ) {
        reasons.push(
          `Clinical-data audit ${label} has an invalid ${field} list.`,
        );
      } else if (findings.length > 0) {
        reasons.push(`Clinical-data audit ${label} reports ${field}.`);
      }
    }
    if (audit.releaseSafe !== true) {
      reasons.push(`Clinical-data audit ${label} is not release-safe.`);
    }
  }

  return {
    ready: reasons.length === 0,
    releaseSha,
    databaseTargetFingerprint,
    reasons: [...new Set(reasons)],
  };
}
