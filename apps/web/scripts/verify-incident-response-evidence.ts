#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateIncidentResponseEvidence } from "../lib/incident-response-evidence";

const MAX_EVIDENCE_BYTES = 1024 * 1024;

function inputPath(args: string[]): string {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (
    normalized.length !== 2 ||
    normalized[0] !== "--input" ||
    !normalized[1]?.trim()
  ) {
    throw new Error(
      "Usage: incident:verify-evidence -- --input <tabletop-evidence.json>",
    );
  }
  const candidate = normalized[1].trim();
  return isAbsolute(candidate)
    ? candidate
    : resolve(process.env.INIT_CWD ?? process.cwd(), candidate);
}

export function main(args = process.argv.slice(2), nowMs = Date.now()) {
  const path = inputPath(args);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new Error("Incident-response evidence is unavailable or unreadable.");
  }
  if (!stat.isFile()) {
    throw new Error("Incident-response evidence must be a regular file.");
  }
  if (stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error(
      "Incident-response evidence exceeds the 1 MB safety limit.",
    );
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Incident-response evidence must contain valid JSON.");
  }
  const decision = evaluateIncidentResponseEvidence(evidence, nowMs);
  console.log(JSON.stringify(decision, null, 2));
  if (!decision.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
