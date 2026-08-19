#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OPENVPM_VERCEL_PROJECT = {
  projectId: "prj_JPnDKk7y38zGp4XzmgM8pgZiIVU2",
  orgId: "team_pCrJiPcUhTPGlAcRDYiRGAEH",
  projectName: "openvpm-app",
} as const;

type ProjectIdentityResult = {
  ok: boolean;
  issue?: string;
};

export function verifyVercelProjectIdentity(
  input: unknown,
): ProjectIdentityResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issue: "Vercel project link is invalid" };
  }
  const value = input as Record<string, unknown>;
  for (const [key, expected] of Object.entries(OPENVPM_VERCEL_PROJECT)) {
    if (value[key] !== expected) {
      return {
        ok: false,
        issue: `Vercel project link does not match OpenVPM (${key})`,
      };
    }
  }
  return { ok: true };
}

function main(): void {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const projectFile = resolve(repositoryRoot, ".vercel/project.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(projectFile, "utf8"));
  } catch {
    throw new Error(
      "Repository root is not linked to the OpenVPM Vercel project",
    );
  }
  const result = verifyVercelProjectIdentity(parsed);
  if (!result.ok) throw new Error(result.issue);
  process.stdout.write("PASS OpenVPM Vercel project identity\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Vercel project verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
