#!/usr/bin/env node

import { verifyStagingDatabaseTarget } from "../lib/staging-database-target";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

try {
  const evidence = verifyStagingDatabaseTarget({
    databaseUrl: requiredEnvironment("STAGING_DATABASE_URL"),
    expectedProjectRef: requiredEnvironment("STAGING_PROJECT_REF"),
  });
  console.log(
    JSON.stringify({
      status: "passed",
      ...evidence,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
