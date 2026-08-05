import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is, sql } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as schema from "./schema/index";

/**
 * Schema drift detection.
 *
 * The app's Drizzle schema is the source of truth for what the running code
 * expects. When a deploy ships a schema change whose migration was never
 * applied, the code keeps querying a column the database does not have and the
 * failure only surfaces as a 500 on whichever page happens to touch it — which
 * is how "column prescriptions.product_id does not exist" reached a customer
 * instead of an alert.
 *
 * This compares what the schema *declares* against what the database *has*, so
 * any environment running ahead of its database reports unhealthy immediately
 * rather than silently erroring one feature at a time.
 *
 * Deliberately one-directional: extra tables/columns in the database are not
 * drift. Rolling deploys and expand-then-contract migrations both leave columns
 * behind on purpose, and flagging them would make the check cry wolf.
 */

export type DeclaredColumn = {
  table: string;
  column: string;
};

export type SchemaDrift = {
  missingTables: string[];
  missingColumns: DeclaredColumn[];
};

/** Every table the Drizzle schema declares, with its database column names. */
export function declaredSchema(): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();

  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTableClass)) continue;
    const config = getTableConfig(exported as PgTable);
    // Views and tables outside the default schema are managed elsewhere.
    if (config.schema && config.schema !== "public") continue;
    declared.set(
      config.name,
      new Set(config.columns.map((column) => column.name))
    );
  }

  return declared;
}

type ColumnRow = { table_name: string; column_name: string };

type Queryable = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

function toRows(result: unknown): ColumnRow[] {
  // postgres-js returns the rows array directly; node-postgres wraps them in
  // { rows }. Support both so this works against the app client and a plain
  // script connection.
  if (Array.isArray(result)) return result as ColumnRow[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as ColumnRow[];
  }
  return [];
}

/**
 * Compare the declared schema against the live database.
 *
 * One introspection query, no per-table round trips, so this is cheap enough to
 * run on a health check.
 */
export async function findSchemaDrift(db: Queryable): Promise<SchemaDrift> {
  const result = await db.execute(sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
  `);

  const live = new Map<string, Set<string>>();
  for (const row of toRows(result)) {
    const existing = live.get(row.table_name);
    if (existing) {
      existing.add(row.column_name);
    } else {
      live.set(row.table_name, new Set([row.column_name]));
    }
  }

  const missingTables: string[] = [];
  const missingColumns: DeclaredColumn[] = [];

  for (const [table, columns] of declaredSchema()) {
    const liveColumns = live.get(table);
    if (!liveColumns) {
      missingTables.push(table);
      continue;
    }
    for (const column of columns) {
      if (!liveColumns.has(column)) {
        missingColumns.push({ table, column });
      }
    }
  }

  missingTables.sort();
  missingColumns.sort((a, b) =>
    a.table === b.table
      ? a.column.localeCompare(b.column)
      : a.table.localeCompare(b.table)
  );

  return { missingTables, missingColumns };
}

export function driftIsClean(drift: SchemaDrift): boolean {
  return drift.missingTables.length === 0 && drift.missingColumns.length === 0;
}

/** Short operator-facing summary, e.g. "2 tables and 1 column missing". */
export function describeDrift(drift: SchemaDrift): string {
  if (driftIsClean(drift)) return "Database schema matches the deployed code";

  const parts: string[] = [];
  if (drift.missingTables.length > 0) {
    parts.push(
      `${drift.missingTables.length} table${
        drift.missingTables.length === 1 ? "" : "s"
      } missing (${drift.missingTables.slice(0, 5).join(", ")}${
        drift.missingTables.length > 5 ? ", …" : ""
      })`
    );
  }
  if (drift.missingColumns.length > 0) {
    const shown = drift.missingColumns
      .slice(0, 5)
      .map((c) => `${c.table}.${c.column}`)
      .join(", ");
    parts.push(
      `${drift.missingColumns.length} column${
        drift.missingColumns.length === 1 ? "" : "s"
      } missing (${shown}${drift.missingColumns.length > 5 ? ", …" : ""})`
    );
  }
  return `Database is behind the deployed code: ${parts.join("; ")}`;
}
