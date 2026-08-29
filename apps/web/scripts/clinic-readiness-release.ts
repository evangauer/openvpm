#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { evaluateClinicReadinessRelease } from "../lib/clinic-readiness-release";

const MAX_EVIDENCE_BYTES = 1024 * 1024;

function inputPath(args: string[]): string {
  const index = args.indexOf("--input");
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) throw new Error("Usage: release:clinic-readiness -- --input <evidence.json>");
  return value;
}

export function main(args = process.argv.slice(2)) {
  const path = inputPath(args);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("Release evidence must be a regular file.");
  if (stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error("Release evidence exceeds the 1 MB safety limit.");
  }
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  const decision = evaluateClinicReadinessRelease(evidence);
  console.log(JSON.stringify(decision, null, 2));
  if (decision.decision !== "GO") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
