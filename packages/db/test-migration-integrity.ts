import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadExpectedMigrations,
  validateAppliedLedger,
  validateAppliedLedgerPrefix,
  validateJournalEntries,
  type MigrationJournalEntry,
} from "./migration-integrity";

const here = dirname(fileURLToPath(import.meta.url));
const current = loadExpectedMigrations(join(here, "drizzle"));
assert.deepEqual(current.errors, []);
assert.ok(current.expected.length > 0);

const base = (idx: number, when: number): MigrationJournalEntry => ({
  idx,
  version: "7",
  when,
  tag: `${String(idx).padStart(4, "0")}_fixture`,
  breakpoints: true,
});

assert.match(
  validateJournalEntries([base(0, 200), base(1, 199)]).join("\n"),
  /not strictly increasing/,
  "a future-dated head followed by an older generated migration must fail",
);
assert.match(
  validateJournalEntries([base(0, 100), { ...base(1, 200), idx: 3 }]).join(
    "\n",
  ),
  /expected 1/,
);

const expected = current.expected.slice(0, 2);
const exactApplied = expected.map((entry) => ({
  hash: entry.hash,
  createdAt: entry.when,
}));
assert.deepEqual(validateAppliedLedger(expected, exactApplied), []);
assert.match(
  validateAppliedLedger(expected, exactApplied.slice(0, 1)).join("\n"),
  /count/,
);
assert.match(
  validateAppliedLedger(expected, [
    exactApplied[0]!,
    { ...exactApplied[1]!, hash: "0".repeat(64) },
  ]).join("\n"),
  /hash mismatch/,
);
assert.deepEqual(
  validateAppliedLedgerPrefix(expected, exactApplied.slice(0, 1)),
  [],
);
assert.match(
  validateAppliedLedgerPrefix(expected.slice(0, 1), exactApplied).join("\n"),
  /ahead of committed/,
);

console.log("Migration integrity contracts passed.");
