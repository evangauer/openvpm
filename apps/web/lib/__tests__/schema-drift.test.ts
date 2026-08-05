import { describe, expect, it } from "vitest";
import {
  declaredSchema,
  describeDrift,
  driftIsClean,
  findSchemaDrift,
} from "@openpims/db/schema-drift";

/**
 * Regression cover for the failure that reached a customer: the deployed code
 * queried prescriptions.product_id against a database that never got the
 * migration, and nothing reported it until someone emailed.
 */

type ColumnRow = { table_name: string; column_name: string };

/** Stand-in for the Drizzle client that returns a fixed information_schema. */
function fakeDb(rows: ColumnRow[]) {
  return { execute: async () => rows };
}

/** The live database, minus whatever we want to pretend was never migrated. */
function liveSchemaWithout(omit: (row: ColumnRow) => boolean): ColumnRow[] {
  const rows: ColumnRow[] = [];
  for (const [table, columns] of declaredSchema()) {
    for (const column of columns) {
      const row = { table_name: table, column_name: column };
      if (!omit(row)) rows.push(row);
    }
  }
  return rows;
}

describe("declaredSchema", () => {
  it("picks up the real application tables", () => {
    const declared = declaredSchema();
    expect(declared.has("prescriptions")).toBe(true);
    expect(declared.has("soap_notes")).toBe(true);
    expect(declared.get("prescriptions")?.has("product_id")).toBe(true);
    expect(declared.get("soap_notes")?.has("imported")).toBe(true);
  });

  it("uses database column names, not camelCase property names", () => {
    expect(declaredSchema().get("prescriptions")?.has("productId")).toBe(false);
  });
});

describe("findSchemaDrift", () => {
  it("reports no drift when the database matches the code", async () => {
    const drift = await findSchemaDrift(fakeDb(liveSchemaWithout(() => false)));
    expect(drift).toEqual({ missingTables: [], missingColumns: [] });
    expect(driftIsClean(drift)).toBe(true);
  });

  it("catches a missing column (the prescriptions.product_id outage)", async () => {
    const db = fakeDb(
      liveSchemaWithout(
        (row) =>
          row.table_name === "prescriptions" && row.column_name === "product_id"
      )
    );

    const drift = await findSchemaDrift(db);

    expect(drift.missingColumns).toContainEqual({
      table: "prescriptions",
      column: "product_id",
    });
    expect(drift.missingTables).toEqual([]);
    expect(driftIsClean(drift)).toBe(false);
  });

  it("catches a missing column (the soap_notes.imported outage)", async () => {
    const db = fakeDb(
      liveSchemaWithout(
        (row) =>
          row.table_name === "soap_notes" && row.column_name === "imported"
      )
    );

    const drift = await findSchemaDrift(db);

    expect(drift.missingColumns).toContainEqual({
      table: "soap_notes",
      column: "imported",
    });
    expect(driftIsClean(drift)).toBe(false);
  });

  it("catches an entirely missing table without also listing its columns", async () => {
    const db = fakeDb(
      liveSchemaWithout((row) => row.table_name === "wellness_plans")
    );

    const drift = await findSchemaDrift(db);

    expect(drift.missingTables).toContain("wellness_plans");
    expect(
      drift.missingColumns.some((c) => c.table === "wellness_plans")
    ).toBe(false);
  });

  it("ignores extra tables and columns the database has but the code does not", async () => {
    const rows = liveSchemaWithout(() => false);
    rows.push({ table_name: "legacy_scratch", column_name: "id" });
    rows.push({ table_name: "prescriptions", column_name: "retired_field" });

    const drift = await findSchemaDrift(fakeDb(rows));

    expect(driftIsClean(drift)).toBe(true);
  });

  it("reads node-postgres style { rows } results as well as arrays", async () => {
    const rows = liveSchemaWithout(() => false);
    const drift = await findSchemaDrift({ execute: async () => ({ rows }) });
    expect(driftIsClean(drift)).toBe(true);
  });

  it("treats an empty database as fully drifted rather than healthy", async () => {
    const drift = await findSchemaDrift(fakeDb([]));
    expect(drift.missingTables.length).toBeGreaterThan(10);
    expect(driftIsClean(drift)).toBe(false);
  });
});

describe("describeDrift", () => {
  it("names the missing objects so the operator knows what to apply", async () => {
    const drift = await findSchemaDrift(
      fakeDb(
        liveSchemaWithout(
          (row) =>
            row.table_name === "soap_notes" && row.column_name === "imported"
        )
      )
    );

    const summary = describeDrift(drift);
    expect(summary).toContain("soap_notes.imported");
    expect(summary).toContain("behind the deployed code");
  });

  it("says so plainly when the schema is clean", () => {
    expect(describeDrift({ missingTables: [], missingColumns: [] })).toBe(
      "Database schema matches the deployed code"
    );
  });

  it("truncates long lists instead of dumping every object", () => {
    const summary = describeDrift({
      missingTables: ["a", "b", "c", "d", "e", "f", "g"],
      missingColumns: [],
    });
    expect(summary).toContain("7 tables missing");
    expect(summary).toContain("…");
  });
});
