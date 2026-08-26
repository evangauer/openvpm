import { describe, expect, it } from "vitest";
import {
  criticalDatabaseContract,
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

type SchemaObjectRow = {
  object_type:
    | "column"
    | "constraint"
    | "index"
    | "trigger"
    | "rls_policy"
    | "table_privilege"
    | "forbidden_table_privilege"
    | "forbidden_function_privilege";
  table_name: string;
  object_name: string;
  healthy: boolean;
};

/** Stand-in for the Drizzle client that returns a fixed information_schema. */
function fakeDb(rows: SchemaObjectRow[]) {
  return { execute: async () => rows };
}

/** The live database, minus whatever we want to pretend was never migrated. */
function liveSchemaWithout(
  omit: (row: SchemaObjectRow) => boolean,
): SchemaObjectRow[] {
  const rows: SchemaObjectRow[] = [];
  for (const [table, columns] of declaredSchema()) {
    for (const column of columns) {
      const row: SchemaObjectRow = {
        object_type: "column",
        table_name: table,
        object_name: column,
        healthy: true,
      };
      if (!omit(row)) rows.push(row);
    }
  }
  for (const object of criticalDatabaseContract()) {
    const row: SchemaObjectRow = {
      object_type: object.kind,
      table_name: object.table,
      object_name: object.name,
      healthy: true,
    };
    if (!omit(row)) rows.push(row);
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
    expect(declared.get("migration_runs")?.has("reviewed_plan_hash")).toBe(
      true,
    );
  });

  it("uses database column names, not camelCase property names", () => {
    expect(declaredSchema().get("prescriptions")?.has("productId")).toBe(false);
  });
});

describe("findSchemaDrift", () => {
  it("gates the portal session tenant boundary and lookup controls", () => {
    expect(criticalDatabaseContract()).toEqual(
      expect.arrayContaining([
        {
          kind: "constraint",
          table: "clients",
          name: "clients_portal_access_token_state_check",
        },
        {
          kind: "constraint",
          table: "portal_sessions",
          name: "portal_sessions_client_tenant_fk",
        },
        {
          kind: "index",
          table: "portal_sessions",
          name: "portal_sessions_token_hash_uq",
        },
        {
          kind: "rls_policy",
          table: "portal_sessions",
          name: "tenant_isolation",
        },
      ]),
    );
  });

  it("reports no drift when the database matches the code", async () => {
    const drift = await findSchemaDrift(fakeDb(liveSchemaWithout(() => false)));
    expect(drift).toEqual({
      missingTables: [],
      missingColumns: [],
      invalidObjects: [],
    });
    expect(driftIsClean(drift)).toBe(true);
  });

  it("catches a missing column (the prescriptions.product_id outage)", async () => {
    const db = fakeDb(
      liveSchemaWithout(
        (row) =>
          row.object_type === "column" &&
          row.table_name === "prescriptions" &&
          row.object_name === "product_id",
      ),
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
          row.object_type === "column" &&
          row.table_name === "soap_notes" &&
          row.object_name === "imported",
      ),
    );

    const drift = await findSchemaDrift(db);

    expect(drift.missingColumns).toContainEqual({
      table: "soap_notes",
      column: "imported",
    });
    expect(driftIsClean(drift)).toBe(false);
  });

  it("catches a missing migration_runs.reviewed_plan_hash deployment", async () => {
    const db = fakeDb(
      liveSchemaWithout(
        (row) =>
          row.object_type === "column" &&
          row.table_name === "migration_runs" &&
          row.object_name === "reviewed_plan_hash",
      ),
    );

    const drift = await findSchemaDrift(db);

    expect(drift.missingColumns).toContainEqual({
      table: "migration_runs",
      column: "reviewed_plan_hash",
    });
    expect(driftIsClean(drift)).toBe(false);
  });

  it("catches an entirely missing table without also listing its columns", async () => {
    const db = fakeDb(
      liveSchemaWithout((row) => row.table_name === "wellness_plans"),
    );

    const drift = await findSchemaDrift(db);

    expect(drift.missingTables).toContain("wellness_plans");
    expect(drift.missingColumns.some((c) => c.table === "wellness_plans")).toBe(
      false,
    );
  });

  it("ignores extra tables and columns the database has but the code does not", async () => {
    const rows = liveSchemaWithout(() => false);
    rows.push({
      object_type: "column",
      table_name: "legacy_scratch",
      object_name: "id",
      healthy: true,
    });
    rows.push({
      object_type: "column",
      table_name: "prescriptions",
      object_name: "retired_field",
      healthy: true,
    });

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

  it("catches a missing critical constraint", async () => {
    const drift = await findSchemaDrift(
      fakeDb(
        liveSchemaWithout(
          (row) =>
            row.object_type === "constraint" &&
            row.object_name === "files_uploader_tenant_fk",
        ),
      ),
    );

    expect(drift.invalidObjects).toContainEqual({
      kind: "constraint",
      table: "files",
      name: "files_uploader_tenant_fk",
    });
    expect(driftIsClean(drift)).toBe(false);
  });

  it("catches a NOT VALID constraint or invalid index", async () => {
    const rows = liveSchemaWithout(() => false).map((row) =>
      row.object_name === "files_available_evidence_check" ||
      row.object_name === "file_object_replicas_due_idx"
        ? { ...row, healthy: false }
        : row,
    );
    const drift = await findSchemaDrift(fakeDb(rows));

    expect(drift.invalidObjects.map((object) => object.name)).toEqual([
      "files_available_evidence_check",
      "file_object_replicas_due_idx",
    ]);
  });

  it("requires validated recovery-hold and signature-evidence guards", async () => {
    const required = criticalDatabaseContract()
      .filter(
        (object) =>
          object.name === "practices_recovery_hold_evidence_check" ||
          object.name.startsWith("consent_requests_signature_evidence_") ||
          object.name === "consent_requests_signing_evidence_check",
      )
      .map((object) => object.name);

    expect(required).toEqual([
      "practices_recovery_hold_evidence_check",
      "consent_requests_signing_evidence_check",
      "consent_requests_signature_evidence_pair_check",
      "consent_requests_signature_evidence_size_check",
      "consent_requests_signature_evidence_hash_check",
    ]);

    const rows = liveSchemaWithout(() => false).map((row) =>
      row.object_name === "consent_requests_signature_evidence_hash_check"
        ? { ...row, healthy: false }
        : row,
    );
    const drift = await findSchemaDrift(fakeDb(rows));
    expect(drift.invalidObjects).toContainEqual({
      kind: "constraint",
      table: "consent_requests",
      name: "consent_requests_signature_evidence_hash_check",
    });
  });

  it("catches a missing policy and RLS disabled under an existing policy", async () => {
    const rows = liveSchemaWithout(
      (row) =>
        row.object_type === "rls_policy" &&
        row.table_name === "file_storage_events" &&
        row.object_name === "system_insert",
    ).map((row) =>
      row.object_type === "rls_policy" &&
      row.table_name === "file_object_replicas"
        ? { ...row, healthy: false }
        : row,
    );
    const drift = await findSchemaDrift(fakeDb(rows));

    expect(drift.invalidObjects.map((object) => object.name)).toContain(
      "system_only",
    );
    expect(drift.invalidObjects.map((object) => object.name)).toContain(
      "system_insert",
    );
  });

  it("catches a disabled inbox mutation trigger", async () => {
    const rows = liveSchemaWithout(() => false).map((row) =>
      row.object_type === "trigger" &&
      row.table_name === "sms_provider_events" &&
      row.object_name === "sms_provider_events_mutation_guard"
        ? { ...row, healthy: false }
        : row,
    );
    const drift = await findSchemaDrift(fakeDb(rows));

    expect(drift.invalidObjects).toContainEqual({
      kind: "trigger",
      table: "sms_provider_events",
      name: "sms_provider_events_mutation_guard",
    });
  });

  it("catches missing required and present forbidden application privileges", async () => {
    const rows = liveSchemaWithout(
      (row) =>
        row.object_type === "table_privilege" &&
        row.table_name === "file_object_replicas" &&
        row.object_name === "DELETE",
    ).map((row) =>
      row.object_type === "forbidden_table_privilege" &&
      row.table_name === "file_storage_events" &&
      row.object_name === "UPDATE"
        ? { ...row, healthy: false }
        : row,
    );
    const drift = await findSchemaDrift(fakeDb(rows));

    expect(drift.invalidObjects).toContainEqual({
      kind: "table_privilege",
      table: "file_object_replicas",
      name: "DELETE",
    });
    expect(drift.invalidObjects).toContainEqual({
      kind: "forbidden_table_privilege",
      table: "file_storage_events",
      name: "UPDATE",
    });
  });

  it("catches forbidden conflict-review mutation privileges", async () => {
    const rows = liveSchemaWithout(() => false).map((row) =>
      row.object_type === "forbidden_table_privilege" &&
      row.table_name === "sms_provider_event_conflict_reviews" &&
      row.object_name === "DELETE"
        ? { ...row, healthy: false }
        : row,
    );
    const drift = await findSchemaDrift(fakeDb(rows));

    expect(drift.invalidObjects).toContainEqual({
      kind: "forbidden_table_privilege",
      table: "sms_provider_event_conflict_reviews",
      name: "DELETE",
    });
  });
});

describe("describeDrift", () => {
  it("names the missing objects so the operator knows what to apply", async () => {
    const drift = await findSchemaDrift(
      fakeDb(
        liveSchemaWithout(
          (row) =>
            row.object_type === "column" &&
            row.table_name === "soap_notes" &&
            row.object_name === "imported",
        ),
      ),
    );

    const summary = describeDrift(drift);
    expect(summary).toContain("soap_notes.imported");
    expect(summary).toContain("behind the deployed code");
  });

  it("says so plainly when the schema is clean", () => {
    expect(
      describeDrift({
        missingTables: [],
        missingColumns: [],
        invalidObjects: [],
      }),
    ).toBe("Database schema matches the deployed code");
  });

  it("truncates long lists instead of dumping every object", () => {
    const summary = describeDrift({
      missingTables: ["a", "b", "c", "d", "e", "f", "g"],
      missingColumns: [],
      invalidObjects: [],
    });
    expect(summary).toContain("7 tables missing");
    expect(summary).toContain("…");
  });
});
