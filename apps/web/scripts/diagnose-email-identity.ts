#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  diagnoseEmailIdentity,
  type IdentityCandidate,
  type IdentitySnapshot,
} from "../lib/email-identity-diagnosis";

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const DATABASE_URL_ENV = "DIAGNOSE_DATABASE_URL";

function usage(): string {
  return [
    "Usage:",
    "  DIAGNOSE_DATABASE_URL=... KEY_A=... KEY_B=... \\",
    "    pnpm email-identity:diagnose --candidate KEY_A --candidate KEY_B",
    "",
    "Read-only. Candidates are environment variable NAMES; key values never",
    "appear in arguments or output. Output contains key fingerprints (which the",
    "database already stores) and record counts only.",
  ].join("\n");
}

export function parseCandidateNames(argv: readonly string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (argument === "--candidate") {
      const name = argv[++index];
      if (!name || !ENV_NAME_PATTERN.test(name) || names.includes(name)) {
        throw new Error("invalid_candidate_name");
      }
      names.push(name);
      continue;
    }
    throw new Error("invalid_arguments");
  }
  if (names.length === 0) throw new Error("no_candidates");
  return names;
}

async function loadSnapshot(sql: postgres.Sql): Promise<IdentitySnapshot> {
  return sql.begin(
    "isolation level repeatable read read only",
    async (transaction) => {
      // postgres-js drops TransactionSql call signatures in its types.
      const tx = transaction as unknown as postgres.Sql;
      const [registry] = await tx<
        {
          identity_key_fingerprint: string;
          previous_identity_key_fingerprint: string | null;
          rotation_started_at: Date | null;
        }[]
      >`select identity_key_fingerprint, previous_identity_key_fingerprint,
             rotation_started_at
        from platform_email_identity where key_slot = 1`;
      const preferenceRows = await tx<
        { fingerprint: string; preferences: number; opt_outs: number }[]
      >`select identity_key_fingerprint as fingerprint,
             count(*)::int as preferences,
             count(*) filter (where not marketing_enabled)::int as opt_outs
        from platform_email_preferences
       where deleted_at is null
       group by identity_key_fingerprint`;
      const eventRows = await tx<{ fingerprint: string; events: number }[]>`
      select identity_key_fingerprint as fingerprint, count(*)::int as events
        from platform_email_preference_events
       group by identity_key_fingerprint`;
      const [aliasRow] = await tx<{ aliases: number }[]>`
      select count(*)::int as aliases from platform_email_identity_aliases`;

      const byFingerprint = new Map<
        string,
        {
          fingerprint: string;
          preferences: number;
          optOuts: number;
          events: number;
        }
      >();
      const entry = (fingerprint: string) => {
        let row = byFingerprint.get(fingerprint);
        if (!row) {
          row = { fingerprint, preferences: 0, optOuts: 0, events: 0 };
          byFingerprint.set(fingerprint, row);
        }
        return row;
      };
      for (const row of preferenceRows) {
        const target = entry(row.fingerprint);
        target.preferences = row.preferences;
        target.optOuts = row.opt_outs;
      }
      for (const row of eventRows) entry(row.fingerprint).events = row.events;

      return {
        registry: registry
          ? {
              identityKeyFingerprint: registry.identity_key_fingerprint,
              previousIdentityKeyFingerprint:
                registry.previous_identity_key_fingerprint,
              rotationStartedAt:
                registry.rotation_started_at?.toISOString() ?? null,
            }
          : null,
        byFingerprint: [...byFingerprint.values()],
        aliases: aliasRow?.aliases ?? 0,
      };
    },
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const names = parseCandidateNames(argv);
  const databaseUrl = process.env[DATABASE_URL_ENV];
  if (!databaseUrl) throw new Error(`${DATABASE_URL_ENV}_not_set`);

  const candidates: IdentityCandidate[] = names.map((name) => ({
    name,
    secret: process.env[name],
  }));
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const diagnosis = diagnoseEmailIdentity(
      await loadSnapshot(sql),
      candidates,
    );
    process.stdout.write(`${JSON.stringify(diagnosis, null, 2)}\n`);
    return diagnosis.verdict === "no_match_with_preferences" ? 2 : 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const code = error instanceof Error ? error.message : "unknown_error";
      // Never echo connection strings or driver messages that may carry them.
      process.stderr.write(
        `${/^[a-z_A-Z]+$/.test(code) ? code : "diagnosis_failed"}\n\n${usage()}\n`,
      );
      process.exit(1);
    },
  );
}
