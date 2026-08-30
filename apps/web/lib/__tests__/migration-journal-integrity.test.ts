import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  snapshotlessMigrationPostconditions,
  snapshotlessMigrationReasons,
} from "../../../../packages/db/baseline";

type JournalEntry = {
  idx: number;
  version: string;
  tag: string;
  when: number;
  breakpoints: boolean;
};

type Journal = {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

type Snapshot = {
  id: string;
  prevId: string;
};

type MigrationFixture = {
  journal: Journal;
  sqlFiles: string[];
  snapshots: Record<string, Snapshot>;
};

const repoRoot = resolve(process.cwd(), "../..");
const migrationDirectory = resolve(repoRoot, "packages/db/drizzle");
const metadataDirectory = resolve(migrationDirectory, "meta");
const journalPath = resolve(metadataDirectory, "_journal.json");
const zeroSnapshotId = "00000000-0000-0000-0000-000000000000";

const managedReleaseTail = [
  [97, "0097_clean_captain_midlands", 1787773865136],
  [98, "0098_bitter_midnight", 1787775474728],
  [99, "0099_perpetual_blue_shield", 1788015097229],
  [100, "0100_yielding_pyro", 1788015427667],
  [101, "0101_glorious_maelstrom", 1788016103861],
  [102, "0102_lame_lorna_dane", 1788047504469],
  [103, "0103_elite_lyja", 1788050480016],
  [104, "0104_majestic_electro", 1788058248275],
  [105, "0105_rich_mandroid", 1788060652516],
  [106, "0106_recovery_two_passkey_closure", 1788062315660],
  [107, "0107_reconcile_development_release_line", 1788108893742],
] as const;

const managedReleaseSqlHashes = new Map([
  [
    "0097_clean_captain_midlands",
    "94fc3356526476c9d8d6513edf3f3440396450ce87987f2399791c106b75d92c",
  ],
  [
    "0098_bitter_midnight",
    "627b2605aef17fdba05c89506505577b27dbd3c3815f41505da5a58def1dd69b",
  ],
  [
    "0099_perpetual_blue_shield",
    "77dea68c2d42ffc788166c77fe56c7a9dd3199bb864c9cad0d2cba2d7f627dcd",
  ],
  [
    "0100_yielding_pyro",
    "2b566d6a8118c0851bf9996a7e00cffdc53a5bd1334c9b1f5b43f89df9266988",
  ],
  [
    "0101_glorious_maelstrom",
    "e4f0fc53a2e2afc48d1d935bf98782c1959cd84438576607bae7fb1110bee554",
  ],
  [
    "0102_lame_lorna_dane",
    "e4471600629b4cd1defd2204aefc8f257a4320ef8694f0d048da0994ac9bd85a",
  ],
  [
    "0103_elite_lyja",
    "199d28ac0d59443cf0c0dccd7e46256852bc15ed51aaed87fe0be4bff4f1d3a5",
  ],
  [
    "0104_majestic_electro",
    "da1c5309169993cef1879d9369b2f200ce238c5a8ed8ec56fecc73c26cd931fc",
  ],
  [
    "0105_rich_mandroid",
    "872faf7961a0fe494425aea120d70915ced5ca0bd29c8dc15a2feb51cca98632",
  ],
  [
    "0106_recovery_two_passkey_closure",
    "819c5c06a0dcaaa989aab9912fb9d440afb449e6e938c4e6f427c3ec9f349da6",
  ],
  [
    "0107_reconcile_development_release_line",
    "0ab3ea75a90e4944ae4e5d6eea02aab854e1c8c11963568f1d15536ebf3230ce",
  ],
]);

const releaseLineReplacementArtifacts = [
  { status: "D", path: "packages/db/drizzle/0097_handy_toad_men.sql" },
  { status: "D", path: "packages/db/drizzle/0098_shallow_jackpot.sql" },
  { status: "M", path: "packages/db/drizzle/meta/0097_snapshot.json" },
  { status: "M", path: "packages/db/drizzle/meta/0098_snapshot.json" },
];

// There are currently no SQL/journal bijection exceptions. This named,
// reviewed allowlist prevents a future exception from being smuggled in as an
// unexplained filtering rule.
const sqlBijectionExceptions = new Set<string>();

function migrationPrefix(tag: string): string {
  const match = /^(\d{4})_[a-z0-9_]+$/.exec(tag);
  if (!match) throw new Error(`invalid migration tag ${tag}`);
  return match[1]!;
}

function loadFixture(): MigrationFixture {
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  const sqlFiles = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const snapshots = Object.fromEntries(
    readdirSync(metadataDirectory)
      .filter((name) => /^\d{4}_snapshot\.json$/.test(name))
      .sort()
      .map((name) => [
        name,
        JSON.parse(
          readFileSync(resolve(metadataDirectory, name), "utf8"),
        ) as Snapshot,
      ]),
  );
  return { journal, sqlFiles, snapshots };
}

function cloneFixture(fixture: MigrationFixture): MigrationFixture {
  return {
    journal: structuredClone(fixture.journal),
    sqlFiles: [...fixture.sqlFiles],
    // Mutation tests only alter top-level lineage IDs. Keep the large table
    // payloads shared and immutable so each negative case stays deterministic
    // under hosted-runner load.
    snapshots: Object.fromEntries(
      Object.entries(fixture.snapshots).map(([name, snapshot]) => [
        name,
        { ...snapshot },
      ]),
    ),
  };
}

const canonicalFixture = loadFixture();

function validateJournal(journal: Journal): void {
  if (journal.version !== "7") {
    throw new Error(`unsupported journal version ${String(journal.version)}`);
  }
  if (journal.dialect !== "postgresql") {
    throw new Error(`unsupported journal dialect ${String(journal.dialect)}`);
  }
  if (journal.entries.length === 0) throw new Error("journal is empty");

  const indexes = new Set<number>();
  const tags = new Set<string>();
  for (const [position, entry] of journal.entries.entries()) {
    if (!Number.isSafeInteger(entry.idx) || entry.idx < 0) {
      throw new Error(`invalid journal index ${String(entry.idx)}`);
    }
    if (entry.version !== journal.version) {
      throw new Error(
        `journal entry ${position} has version ${String(entry.version)}; expected ${journal.version}`,
      );
    }
    if (typeof entry.breakpoints !== "boolean") {
      throw new Error(
        `journal entry ${position} has invalid breakpoints ${String(entry.breakpoints)}`,
      );
    }
    if (
      typeof entry.when !== "number" ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= 0
    ) {
      throw new Error(
        `journal entry ${position} has invalid timestamp ${String(entry.when)}`,
      );
    }
    if (typeof entry.tag !== "string") {
      throw new Error(
        `journal entry ${position} has invalid tag ${String(entry.tag)}`,
      );
    }
    if (indexes.has(entry.idx)) {
      throw new Error(`duplicate journal index ${entry.idx}`);
    }
    indexes.add(entry.idx);
    if (entry.idx !== position) {
      throw new Error(
        `journal indexes must be contiguous from 0: position ${position} has ${entry.idx}`,
      );
    }

    if (tags.has(entry.tag))
      throw new Error(`duplicate journal tag ${entry.tag}`);
    tags.add(entry.tag);

    const prefix = migrationPrefix(entry.tag);
    if (prefix !== String(entry.idx).padStart(4, "0")) {
      throw new Error(
        `journal tag ${entry.tag} does not match index ${entry.idx}`,
      );
    }

    const previous = journal.entries[position - 1];
    if (previous && entry.when <= previous.when) {
      throw new Error(
        `journal timestamps must strictly increase: ${entry.tag} (${entry.when}) follows ${previous.tag} (${previous.when})`,
      );
    }
  }
}

function validateSqlBijection(fixture: MigrationFixture): void {
  const journalTags = fixture.journal.entries
    .map((entry) => entry.tag)
    .filter((tag) => !sqlBijectionExceptions.has(tag));
  const sqlTags = fixture.sqlFiles
    .map((name) => name.replace(/\.sql$/, ""))
    .filter((tag) => !sqlBijectionExceptions.has(tag));

  for (const tag of journalTags) {
    const matches = sqlTags.filter((candidate) => candidate === tag).length;
    if (matches !== 1) {
      throw new Error(
        `journal migration ${tag} must map to exactly one SQL file; found ${matches}`,
      );
    }
  }

  const journalTagSet = new Set(journalTags);
  for (const tag of sqlTags) {
    if (!journalTagSet.has(tag)) {
      throw new Error(`orphan SQL migration ${tag}.sql is not in the journal`);
    }
  }
}

function validateSnapshotLineage(fixture: MigrationFixture): void {
  const entriesByPrefix = new Map(
    fixture.journal.entries.map((entry) => [migrationPrefix(entry.tag), entry]),
  );
  const expectedSnapshotNames = fixture.journal.entries
    .filter((entry) => snapshotlessMigrationReasons[entry.tag] === undefined)
    .map((entry) => `${migrationPrefix(entry.tag)}_snapshot.json`);
  const actualSnapshotNames = Object.keys(fixture.snapshots).sort();

  for (const entry of fixture.journal.entries) {
    const snapshotName = `${migrationPrefix(entry.tag)}_snapshot.json`;
    const snapshotExists = fixture.snapshots[snapshotName] !== undefined;
    const approvedReason = snapshotlessMigrationReasons[entry.tag];
    if (approvedReason && snapshotExists) {
      throw new Error(
        `approved snapshotless migration ${entry.tag} unexpectedly has ${snapshotName}`,
      );
    }
    if (!approvedReason && !snapshotExists) {
      throw new Error(`missing snapshot ${snapshotName} for ${entry.tag}`);
    }
  }

  for (const snapshotName of actualSnapshotNames) {
    const prefix = snapshotName.slice(0, 4);
    if (!entriesByPrefix.has(prefix)) {
      throw new Error(
        `orphan snapshot ${snapshotName} does not map to a journal prefix`,
      );
    }
  }

  if (actualSnapshotNames.join("\n") !== expectedSnapshotNames.join("\n")) {
    throw new Error(
      "snapshot files do not map to the expected migration prefixes",
    );
  }

  let expectedPrevId = zeroSnapshotId;
  const ids = new Set<string>();
  for (const name of expectedSnapshotNames) {
    const snapshot = fixture.snapshots[name]!;
    if (ids.has(snapshot.id)) {
      throw new Error(`duplicate snapshot id ${snapshot.id} in ${name}`);
    }
    ids.add(snapshot.id);
    if (snapshot.prevId !== expectedPrevId) {
      throw new Error(
        `broken snapshot lineage at ${name}: expected prevId ${expectedPrevId}, received ${snapshot.prevId}`,
      );
    }
    expectedPrevId = snapshot.id;
  }
}

function validateIntegrity(fixture: MigrationFixture): void {
  validateJournal(fixture.journal);
  validateSqlBijection(fixture);
  validateSnapshotLineage(fixture);
}

function stripSqlCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/'(?:''|[^'])*'/g, "''");
}

function assertDataOnlySql(tag: string, sql: string): void {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
  const dollarQuote = withoutComments.match(/\$[a-zA-Z0-9_]*\$/);
  if (dollarQuote) {
    throw new Error(
      `${tag} is allowlisted as data-only but contains an unverifiable dollar-quoted body`,
    );
  }
  const proceduralKeyword =
    stripSqlCommentsAndStrings(sql).match(/\b(?:do|execute)\b/i);
  if (proceduralKeyword) {
    throw new Error(
      `${tag} is allowlisted as data-only but contains procedural keyword ${proceduralKeyword[0]}`,
    );
  }

  const ddlKeyword = stripSqlCommentsAndStrings(sql).match(
    /\b(?:create|alter|drop|truncate|rename|grant|revoke|comment|reindex|cluster)\b/i,
  );
  if (ddlKeyword) {
    throw new Error(
      `${tag} is allowlisted as data-only but contains DDL keyword ${ddlKeyword[0]}`,
    );
  }
}

type RawJournalSegments = {
  prefix: string;
  entries: string[];
  suffix: string;
};

/** Split journal entries without normalizing a byte of the existing objects. */
function rawJournalSegments(raw: string): RawJournalSegments {
  const entriesKey = raw.indexOf('"entries"');
  const arrayStart = raw.indexOf("[", entriesKey);
  if (entriesKey === -1 || arrayStart === -1) {
    throw new Error("journal does not contain an entries array");
  }

  const entries: string[] = [];
  let arrayDepth = 1;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let segmentStart = arrayStart + 1;
  let arrayEnd = -1;

  for (let index = arrayStart + 1; index < raw.length; index++) {
    const character = raw[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[") arrayDepth++;
    else if (character === "]") {
      arrayDepth--;
      if (arrayDepth === 0) {
        arrayEnd = index;
        break;
      }
    } else if (character === "{") objectDepth++;
    else if (character === "}") {
      objectDepth--;
      if (objectDepth === 0) {
        entries.push(raw.slice(segmentStart, index + 1));
        segmentStart = index + 1;
      }
    }
  }

  if (arrayEnd === -1) throw new Error("journal entries array is not closed");
  return {
    prefix: raw.slice(0, arrayStart + 1),
    entries,
    suffix: raw.slice(arrayEnd),
  };
}

function gitText(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

type MigrationIntegrityCiContext = {
  eventName?: string;
  pullRequestBaseSha?: string;
  pushBeforeSha?: string;
};

function validCommitSha(value: string | undefined, source: string): string {
  const sha = value?.trim();
  if (!sha) {
    throw new Error(
      `Migration integrity base is missing; expected ${source}. Refusing to compare HEAD to itself.`,
    );
  }
  if (/^0{40}$/.test(sha)) {
    throw new Error(
      `Migration integrity base from ${source} is all zeroes. Refusing to compare HEAD to itself; rerun from an event with a real pre-change commit.`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(
      `Migration integrity base from ${source} is not a full commit SHA: ${sha}.`,
    );
  }
  return sha;
}

function selectCiMigrationBaseRef({
  eventName,
  pullRequestBaseSha,
  pushBeforeSha,
}: MigrationIntegrityCiContext): string {
  if (eventName === "pull_request") {
    return validCommitSha(
      pullRequestBaseSha,
      "github.event.pull_request.base.sha",
    );
  }
  if (eventName === "push") {
    return validCommitSha(pushBeforeSha, "github.event.before");
  }
  throw new Error(
    `Migration integrity does not support GitHub event ${eventName ?? "(missing)"}; expected pull_request or push.`,
  );
}

function configuredMigrationBaseRef(): string | undefined {
  const eventName = process.env.MIGRATION_INTEGRITY_EVENT_NAME?.trim();
  if (eventName) {
    return selectCiMigrationBaseRef({
      eventName,
      pullRequestBaseSha: process.env.MIGRATION_INTEGRITY_PR_BASE_SHA,
      pushBeforeSha: process.env.MIGRATION_INTEGRITY_PUSH_BEFORE_SHA,
    });
  }
  return process.env.MIGRATION_INTEGRITY_BASE_REF?.trim() || undefined;
}

const hasConfiguredMigrationBase = Boolean(
  process.env.MIGRATION_INTEGRITY_EVENT_NAME?.trim() ||
  process.env.MIGRATION_INTEGRITY_BASE_REF?.trim(),
);

describe("Drizzle migration journal integrity", () => {
  it("keeps journal, SQL, and snapshot history deterministic and bijective", () => {
    validateIntegrity(canonicalFixture);
    expect([...sqlBijectionExceptions]).toEqual([]);
    expect(snapshotlessMigrationReasons).toEqual({
      "0052_booking_page_request_types":
        "intentional data-only migration; it changes rows without changing schema",
    });
    expect(Object.keys(snapshotlessMigrationPostconditions).sort()).toEqual(
      Object.keys(snapshotlessMigrationReasons).sort(),
    );

    const pullRequestBase = "1".repeat(40);
    const pushBefore = "2".repeat(40);
    expect(
      selectCiMigrationBaseRef({
        eventName: "pull_request",
        pullRequestBaseSha: pullRequestBase,
        pushBeforeSha: pushBefore,
      }),
    ).toBe(pullRequestBase);
    expect(
      selectCiMigrationBaseRef({
        eventName: "push",
        pullRequestBaseSha: pullRequestBase,
        pushBeforeSha: pushBefore,
      }),
    ).toBe(pushBefore);
    expect(() => selectCiMigrationBaseRef({ eventName: "push" })).toThrow(
      "expected github.event.before",
    );
    expect(() =>
      selectCiMigrationBaseRef({
        eventName: "push",
        pushBeforeSha: "0".repeat(40),
      }),
    ).toThrow("github.event.before is all zeroes");
  });

  it("keeps every approved snapshotless migration data-only and DDL-free", () => {
    for (const tag of Object.keys(snapshotlessMigrationReasons)) {
      const sql = readFileSync(
        resolve(migrationDirectory, `${tag}.sql`),
        "utf8",
      );
      expect(() => assertDataOnlySql(tag, sql)).not.toThrow();
    }

    const bookingPageMigration = readFileSync(
      resolve(migrationDirectory, "0052_booking_page_request_types.sql"),
      "utf8",
    );
    expect(bookingPageMigration).toMatch(/\bUPDATE\s+booking_pages\b/i);
  });

  it("rejects procedural or dollar-quoted DDL in a data-only migration", () => {
    expect(() =>
      assertDataOnlySql(
        "0091_fixture",
        "DO $$ BEGIN EXECUTE 'CREATE TABLE unsafe(id int)'; END $$;",
      ),
    ).toThrow("unverifiable dollar-quoted body");
  });

  it("rejects a duplicate journal index", () => {
    const fixture = cloneFixture(canonicalFixture);
    fixture.journal.entries[1]!.idx = fixture.journal.entries[0]!.idx;
    expect(() => validateIntegrity(fixture)).toThrow("duplicate journal index");
  });

  it("rejects a duplicate journal tag", () => {
    const fixture = cloneFixture(canonicalFixture);
    fixture.journal.entries[1]!.tag = fixture.journal.entries[0]!.tag;
    expect(() => validateIntegrity(fixture)).toThrow("duplicate journal tag");
  });

  it("rejects a journal timestamp regression", () => {
    const fixture = cloneFixture(canonicalFixture);
    fixture.journal.entries[1]!.when = fixture.journal.entries[0]!.when;
    expect(() => validateIntegrity(fixture)).toThrow(
      "journal timestamps must strictly increase",
    );
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["string", "1782547263384"],
    ["object", { value: 1782547263384 }],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s journal timestamp", (_label, value) => {
    const fixture = cloneFixture(canonicalFixture);
    (fixture.journal.entries[1] as unknown as Record<string, unknown>).when =
      value;
    expect(() => validateIntegrity(fixture)).toThrow(
      "journal entry 1 has invalid timestamp",
    );
  });

  it("rejects an invalid journal entry version", () => {
    const fixture = cloneFixture(canonicalFixture);
    fixture.journal.entries[1]!.version = "6";
    expect(() => validateIntegrity(fixture)).toThrow(
      "journal entry 1 has version 6; expected 7",
    );
  });

  it("rejects an invalid journal breakpoint shape", () => {
    const fixture = cloneFixture(canonicalFixture);
    (
      fixture.journal.entries[1] as unknown as Record<string, unknown>
    ).breakpoints = "true";
    expect(() => validateIntegrity(fixture)).toThrow(
      "journal entry 1 has invalid breakpoints true",
    );
  });

  it("rejects a missing SQL migration", () => {
    const fixture = cloneFixture(canonicalFixture);
    fixture.sqlFiles = fixture.sqlFiles.filter(
      (name) => name !== "0052_booking_page_request_types.sql",
    );
    expect(() => validateIntegrity(fixture)).toThrow(
      "0052_booking_page_request_types must map to exactly one SQL file; found 0",
    );
  });

  it("rejects an orphan SQL migration", () => {
    const fixture = cloneFixture(canonicalFixture);
    fixture.sqlFiles.push("0091_orphan_fixture.sql");
    expect(() => validateIntegrity(fixture)).toThrow(
      "orphan SQL migration 0091_orphan_fixture.sql",
    );
  });

  it("rejects broken snapshot lineage", () => {
    const fixture = cloneFixture(canonicalFixture);
    fixture.snapshots["0053_snapshot.json"]!.prevId = zeroSnapshotId;
    expect(() => validateIntegrity(fixture)).toThrow(
      "broken snapshot lineage at 0053_snapshot.json",
    );
  });

  it.skipIf(!hasConfiguredMigrationBase)(
    "preserves merge-base migration artifacts byte-for-byte and adds only at the tail",
    () => {
      const baseRef = configuredMigrationBaseRef()!;
      try {
        gitText("cat-file", "-e", `${baseRef}^{commit}`);
      } catch {
        throw new Error(
          `Migration integrity base ${baseRef} is unavailable in the checkout. Keep actions/checkout fetch-depth at 0 and verify the event SHA exists.`,
        );
      }
      const mergeBase = gitText("merge-base", "HEAD", baseRef);
      const artifactChanges = gitText(
        "diff",
        "--name-status",
        "--no-renames",
        mergeBase,
        "--",
        "packages/db/drizzle",
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [status, path] = line.split("\t");
          return { status: status!, path: path! };
        });
      const changedExistingArtifacts = artifactChanges.filter(
        ({ status, path }) =>
          status !== "A" &&
          (/^packages\/db\/drizzle\/\d{4}_.+\.sql$/.test(path) ||
            /^packages\/db\/drizzle\/meta\/\d{4}_snapshot\.json$/.test(path)),
      );
      const baseJournalRaw = execFileSync(
        "git",
        ["show", `${mergeBase}:packages/db/drizzle/meta/_journal.json`],
        { cwd: repoRoot, encoding: "utf8" },
      );
      const addedArtifacts = artifactChanges.filter(
        ({ status, path }) =>
          status === "A" &&
          (/^packages\/db\/drizzle\/\d{4}_.+\.sql$/.test(path) ||
            /^packages\/db\/drizzle\/meta\/\d{4}_snapshot\.json$/.test(path)),
      );
      for (const { path } of addedArtifacts) {
        expect(readFileSync(resolve(repoRoot, path)).length).toBeGreaterThan(0);
      }

      const currentJournalRaw = readFileSync(journalPath, "utf8");
      const baseSegments = rawJournalSegments(baseJournalRaw);
      const currentSegments = rawJournalSegments(currentJournalRaw);
      const baseJournal = JSON.parse(baseJournalRaw) as Journal;
      const currentJournal = JSON.parse(currentJournalRaw) as Journal;

      const baseDevelopmentTail = baseJournal.entries
        .slice(97)
        .map((entry) => [entry.idx, entry.tag, entry.when]);
      const currentManagedTail = currentJournal.entries
        .slice(97)
        .map((entry) => [entry.idx, entry.tag, entry.when]);
      const isReleaseLineReconciliation =
        JSON.stringify(baseDevelopmentTail) ===
          JSON.stringify([
            [97, "0097_handy_toad_men", 1787682887382],
            [98, "0098_shallow_jackpot", 1787715795778],
          ]) &&
        JSON.stringify(currentManagedTail) ===
          JSON.stringify(managedReleaseTail);

      if (isReleaseLineReconciliation) {
        expect(changedExistingArtifacts).toEqual(
          releaseLineReplacementArtifacts,
        );
        expect(currentSegments.entries.slice(0, 97)).toEqual(
          baseSegments.entries.slice(0, 97),
        );
        expect(currentJournal.entries.slice(0, 97)).toEqual(
          baseJournal.entries.slice(0, 97),
        );

        for (const [tag, expectedHash] of managedReleaseSqlHashes) {
          const sql = readFileSync(resolve(migrationDirectory, `${tag}.sql`));
          expect(createHash("sha256").update(sql).digest("hex")).toBe(
            expectedHash,
          );
        }

        const developmentLifecycleSql = execFileSync(
          "git",
          ["show", `${mergeBase}:packages/db/drizzle/0097_handy_toad_men.sql`],
          { cwd: repoRoot, encoding: "utf8" },
        );
        const developmentCheckoutSql = execFileSync(
          "git",
          ["show", `${mergeBase}:packages/db/drizzle/0098_shallow_jackpot.sql`],
          { cwd: repoRoot, encoding: "utf8" },
        );
        const bridgeSql = readFileSync(
          resolve(
            migrationDirectory,
            "0107_reconcile_development_release_line.sql",
          ),
          "utf8",
        );
        expect(bridgeSql.split(developmentLifecycleSql)).toHaveLength(2);
        expect(bridgeSql.split(developmentCheckoutSql)).toHaveLength(2);
        expect(bridgeSql.indexOf(developmentLifecycleSql)).toBeLessThan(
          bridgeSql.indexOf(developmentCheckoutSql),
        );
      } else {
        expect(
          changedExistingArtifacts,
          "merge-base SQL and snapshots must remain byte-for-byte identical",
        ).toEqual([]);

        expect(currentSegments.prefix).toBe(baseSegments.prefix);
        expect(currentSegments.suffix).toBe(baseSegments.suffix);
        expect(currentSegments.entries.length).toBeGreaterThanOrEqual(
          baseSegments.entries.length,
        );
        expect(
          currentSegments.entries.slice(0, baseSegments.entries.length),
        ).toEqual(baseSegments.entries);
        expect(
          currentJournal.entries.slice(0, baseJournal.entries.length),
        ).toEqual(baseJournal.entries);

        const baseTail = baseJournal.entries.at(-1)!;
        const additions = currentJournal.entries.slice(
          baseJournal.entries.length,
        );
        expect(additions.every((entry) => entry.idx > baseTail.idx)).toBe(true);

        for (const { path } of addedArtifacts) {
          const name = path.split("/").at(-1)!;
          const prefix = Number(name.slice(0, 4));
          expect(
            prefix,
            `${path} was not added after merge-base tail`,
          ).toBeGreaterThan(baseTail.idx);
        }
      }
    },
  );
});
