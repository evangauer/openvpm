#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { collectClinicReadinessEvidence } from "../lib/clinic-readiness-evidence-collector";
import { evaluateClinicReadinessRelease } from "../lib/clinic-readiness-release";

const VALUE_ARGS = new Set([
  "--release-sha",
  "--repository",
  "--ci-run-id",
  "--staging-migration-run-id",
  "--migration-run-id",
  "--staging-health-url",
  "--hosted-health-url",
  "--restore-evidence",
  "--output",
]);

function argumentsMap(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1]?.trim();
    if (!name || !VALUE_ARGS.has(name) || !value || values.has(name)) {
      throw new Error(
        "Usage: release:clinic-readiness:collect -- --release-sha <sha> --repository <owner/name> --ci-run-id <id> --staging-migration-run-id <id> --migration-run-id <id> --staging-health-url <https-url> --hosted-health-url <https-url> --restore-evidence <path> --output <path>",
      );
    }
    values.set(name, value);
  }
  if (values.size !== VALUE_ARGS.size) {
    throw new Error("Every clinic-readiness evidence argument is required.");
  }
  return values;
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
    migrationRunId: positiveInteger(
      values.get("--migration-run-id")!,
      "Production migration run ID",
    ),
    stagingHealthUrl: values.get("--staging-health-url")!,
    hostedHealthUrl: values.get("--hosted-health-url")!,
    restoreEvidencePath: values.get("--restore-evidence")!,
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
  });
  const outputPath = values.get("--output")!;
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const decision = evaluateClinicReadinessRelease(evidence);
  console.log(
    JSON.stringify(
      {
        ...decision,
        evidencePath: outputPath,
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
