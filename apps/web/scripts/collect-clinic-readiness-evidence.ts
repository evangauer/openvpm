#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectClinicReadinessEvidence } from "../lib/clinic-readiness-evidence-collector";
import { evaluateClinicReadinessRelease } from "../lib/clinic-readiness-release";

const VALUE_ARGS = new Set([
  "--release-sha",
  "--repository",
  "--ci-run-id",
  "--staging-migration-run-id",
  "--staging-reset-run-id",
  "--staging-database-fingerprint",
  "--migration-run-id",
  "--staging-health-url",
  "--hosted-health-url",
  "--restore-evidence",
  "--incident-evidence",
  "--auth-recovery-evidence",
  "--clinic-pilot-evidence",
  "--clinic-pilot-projection-audit",
  "--clinical-database-fingerprint",
  "--controlled-substance-audit",
  "--prescription-audit",
  "--lab-result-audit",
  "--vaccination-audit",
  "--output",
]);

function argumentsMap(args: string[]): Map<string, string> {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const values = new Map<string, string>();
  for (let index = 0; index < normalized.length; index += 2) {
    const name = normalized[index];
    const value = normalized[index + 1]?.trim();
    if (!name || !VALUE_ARGS.has(name) || !value || values.has(name)) {
      throw new Error(
        "Usage: release:clinic-readiness:collect -- --release-sha <sha> --repository <owner/name> --ci-run-id <id> --staging-migration-run-id <id> --staging-reset-run-id <id> --staging-database-fingerprint <sha256> --migration-run-id <id> --staging-health-url <https-url> --hosted-health-url <https-url> --restore-evidence <path> --incident-evidence <path> --auth-recovery-evidence <path> --clinic-pilot-evidence <path> --clinic-pilot-projection-audit <path> --clinical-database-fingerprint <sha256> --controlled-substance-audit <path> --prescription-audit <path> --lab-result-audit <path> --vaccination-audit <path> --output <path>",
      );
    }
    values.set(name, value);
  }
  if (values.size !== VALUE_ARGS.size) {
    throw new Error("Every clinic-readiness evidence argument is required.");
  }
  return values;
}

function operatorPath(value: string): string {
  return isAbsolute(value)
    ? value
    : resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function positiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value))
    throw new Error(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export async function main(args = process.argv.slice(2)) {
  const values = argumentsMap(args);
  const evidence = await collectClinicReadinessEvidence({
    releaseSha: values.get("--release-sha")!,
    repository: values.get("--repository")!,
    ciRunId: positiveInteger(values.get("--ci-run-id")!, "CI run ID"),
    stagingMigrationRunId: positiveInteger(
      values.get("--staging-migration-run-id")!,
      "Staging migration run ID",
    ),
    stagingResetRunId: positiveInteger(
      values.get("--staging-reset-run-id")!,
      "Staging reset run ID",
    ),
    stagingDatabaseFingerprint: values.get("--staging-database-fingerprint")!,
    migrationRunId: positiveInteger(
      values.get("--migration-run-id")!,
      "Production migration run ID",
    ),
    stagingHealthUrl: values.get("--staging-health-url")!,
    hostedHealthUrl: values.get("--hosted-health-url")!,
    restoreEvidencePath: operatorPath(values.get("--restore-evidence")!),
    incidentEvidencePath: operatorPath(values.get("--incident-evidence")!),
    authRecoveryEvidencePath: operatorPath(
      values.get("--auth-recovery-evidence")!,
    ),
    clinicPilotEvidencePath: operatorPath(
      values.get("--clinic-pilot-evidence")!,
    ),
    clinicPilotProjectionAuditPath: operatorPath(
      values.get("--clinic-pilot-projection-audit")!,
    ),
    clinicalDatabaseFingerprint: values.get("--clinical-database-fingerprint")!,
    controlledSubstanceAuditPath: operatorPath(
      values.get("--controlled-substance-audit")!,
    ),
    prescriptionAuditPath: operatorPath(values.get("--prescription-audit")!),
    labResultAuditPath: operatorPath(values.get("--lab-result-audit")!),
    vaccinationAuditPath: operatorPath(values.get("--vaccination-audit")!),
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
  });
  const outputPath = operatorPath(values.get("--output")!);
  try {
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw new Error("Clinic-readiness evidence output could not be created.");
  }
  const decision = evaluateClinicReadinessRelease(evidence);
  console.log(
    JSON.stringify(
      {
        ...decision,
        evidenceWritten: true,
      },
      null,
      2,
    ),
  );
  if (decision.decision !== "GO") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
