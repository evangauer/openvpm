import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MigrationJournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

export type ExpectedMigration = MigrationJournalEntry & { hash: string };

export type AppliedMigration = {
  hash: string;
  createdAt: number;
};

type MigrationSnapshot = { id?: unknown; prevId?: unknown };

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
// 0052 was a reviewed hand-written migration added before snapshot enforcement;
// 0053 intentionally continues the 0051 snapshot lineage and includes its live
// schema. Keep this one historical exception explicit so any new omission fails.
const SNAPSHOTLESS_MIGRATION_ALLOWLIST = new Set([
  "0052_booking_page_request_types",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateJournalEntries(
  entries: MigrationJournalEntry[],
): string[] {
  const errors: string[] = [];
  const tags = new Set<string>();

  if (entries.length === 0) errors.push("Migration journal has no entries.");

  entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      errors.push(
        `Journal entry ${entry.tag} has idx ${entry.idx}; expected ${position}.`,
      );
    }
    if (!Number.isSafeInteger(entry.when) || entry.when <= 0) {
      errors.push(`Journal entry ${entry.tag} has an invalid timestamp.`);
    }
    const previous = entries[position - 1];
    if (previous && entry.when <= previous.when) {
      errors.push(
        `Journal timestamp is not strictly increasing: ${entry.tag} (${entry.when}) must be later than ${previous.tag} (${previous.when}).`,
      );
    }
    const expectedPrefix = String(position).padStart(4, "0");
    if (!entry.tag.startsWith(`${expectedPrefix}_`)) {
      errors.push(
        `Journal entry ${entry.tag} must use migration prefix ${expectedPrefix}.`,
      );
    }
    if (tags.has(entry.tag))
      errors.push(`Duplicate migration tag: ${entry.tag}.`);
    tags.add(entry.tag);
  });

  return errors;
}

export function validateAppliedLedger(
  expected: ExpectedMigration[],
  applied: AppliedMigration[],
): string[] {
  const errors: string[] = [];
  if (applied.length !== expected.length) {
    errors.push(
      `Applied migration count ${applied.length} does not match committed count ${expected.length}.`,
    );
  }

  const sharedLength = Math.min(expected.length, applied.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const wanted = expected[index]!;
    const actual = applied[index]!;
    if (actual.createdAt !== wanted.when) {
      errors.push(
        `Applied migration ${index} timestamp ${actual.createdAt} does not match ${wanted.tag} (${wanted.when}).`,
      );
    }
    if (actual.hash !== wanted.hash) {
      errors.push(`Applied migration hash mismatch for ${wanted.tag}.`);
    }
  }
  return errors;
}

export function validateAppliedLedgerPrefix(
  expected: ExpectedMigration[],
  applied: AppliedMigration[],
): string[] {
  if (applied.length > expected.length) {
    return [
      `Applied migration count ${applied.length} is ahead of committed count ${expected.length}.`,
    ];
  }

  const errors: string[] = [];
  for (let index = 0; index < applied.length; index += 1) {
    const wanted = expected[index]!;
    const actual = applied[index]!;
    if (actual.createdAt !== wanted.when) {
      errors.push(
        `Applied migration ${index} timestamp ${actual.createdAt} does not match ${wanted.tag} (${wanted.when}).`,
      );
    }
    if (actual.hash !== wanted.hash) {
      errors.push(`Applied migration hash mismatch for ${wanted.tag}.`);
    }
  }
  return errors;
}

export function loadExpectedMigrations(drizzleDirectory: string): {
  expected: ExpectedMigration[];
  errors: string[];
} {
  const journalPath = join(drizzleDirectory, "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    return { expected: [], errors: ["Migration journal is missing."] };
  }

  let journal: {
    version?: unknown;
    dialect?: unknown;
    entries?: unknown;
  };
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8")) as typeof journal;
  } catch {
    return { expected: [], errors: ["Migration journal is not valid JSON."] };
  }

  const errors: string[] = [];
  if (journal.version !== "7")
    errors.push("Migration journal version must be 7.");
  if (journal.dialect !== "postgresql") {
    errors.push("Migration journal dialect must be postgresql.");
  }
  if (!Array.isArray(journal.entries)) {
    return {
      expected: [],
      errors: [...errors, "Migration journal entries are missing."],
    };
  }

  const entries = journal.entries as MigrationJournalEntry[];
  errors.push(...validateJournalEntries(entries));

  const expected: ExpectedMigration[] = [];
  let previousSnapshotId = ZERO_UUID;
  const snapshotIds = new Set<string>();

  for (const entry of entries) {
    const sqlPath = join(drizzleDirectory, `${entry.tag}.sql`);
    const prefix = entry.tag.slice(0, 4);
    const snapshotPath = join(
      drizzleDirectory,
      "meta",
      `${prefix}_snapshot.json`,
    );

    if (!existsSync(sqlPath)) {
      errors.push(`Migration SQL is missing for ${entry.tag}.`);
      continue;
    }
    const sql = readFileSync(sqlPath, "utf8");
    expected.push({
      ...entry,
      hash: createHash("sha256").update(sql).digest("hex"),
    });

    if (!existsSync(snapshotPath)) {
      if (!SNAPSHOTLESS_MIGRATION_ALLOWLIST.has(entry.tag)) {
        errors.push(`Migration snapshot is missing for ${entry.tag}.`);
      }
      continue;
    }
    let snapshot: MigrationSnapshot;
    try {
      snapshot = JSON.parse(
        readFileSync(snapshotPath, "utf8"),
      ) as MigrationSnapshot;
    } catch {
      errors.push(`Migration snapshot is invalid JSON for ${entry.tag}.`);
      continue;
    }
    if (
      typeof snapshot.id !== "string" ||
      !UUID_PATTERN.test(snapshot.id) ||
      snapshotIds.has(snapshot.id)
    ) {
      errors.push(
        `Migration snapshot ID is invalid or duplicated for ${entry.tag}.`,
      );
    }
    if (snapshot.prevId !== previousSnapshotId) {
      errors.push(
        `Migration snapshot lineage is broken for ${entry.tag}: expected prevId ${previousSnapshotId}.`,
      );
    }
    if (typeof snapshot.id === "string" && UUID_PATTERN.test(snapshot.id)) {
      snapshotIds.add(snapshot.id);
      previousSnapshotId = snapshot.id;
    }
  }

  return { expected, errors };
}
