import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/audit", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchWebhookEvent: vi.fn() }));

const { clientsRouter } = await import("../routers/clients");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-000000000002";
const FOREIGN_CLIENT_ID = "00000000-0000-0000-0000-000000000099";
const dialect = new PgDialect();

function fakeDb(results: unknown[][]) {
  const rows = [...results];
  const conditions: Array<{ sql: string; params: unknown[] }> = [];
  const projections: Array<Record<string, unknown>> = [];
  const limits: number[] = [];
  const select = vi.fn((projection: Record<string, unknown>) => {
    const result = rows.shift() ?? [];
    projections.push(projection);
    const query = {
      from: vi.fn(() => query),
      innerJoin: vi.fn((_table: unknown, condition: SQL) => {
        conditions.push(dialect.sqlToQuery(condition));
        return query;
      }),
      where: vi.fn((condition: SQL) => {
        conditions.push(dialect.sqlToQuery(condition));
        return query;
      }),
      limit: vi.fn((limit: number) => {
        limits.push(limit);
        return query;
      }),
      then: (resolve: (value: unknown[]) => unknown) =>
        Promise.resolve(result).then(resolve),
    };
    return query;
  });
  const execute = vi.fn();
  const db = {
    select,
    execute,
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db, select, conditions, projections, limits };
}

function caller(db: unknown, role = "veterinarian") {
  return clientsRouter.createCaller({
    db,
    session: {
      user: { id: "staff-id", role, practiceId: PRACTICE_ID },
    },
  } as never);
}

describe("client balance tenant and read permissions", () => {
  it("rejects unauthenticated callers before a balance is read", async () => {
    const { db, select } = fakeDb([]);
    await expect(
      clientsRouter.createCaller({ db, session: null } as never)
        .getAccountBalance({ clientId: CLIENT_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(select).not.toHaveBeenCalled();
  });

  it("allows a read-only viewer under the existing staff invoice read policy", async () => {
    const { db } = fakeDb([[{ id: CLIENT_ID, currency: "gbp", country: "GB" }], []]);
    await expect(
      caller(db, "viewer").getAccountBalance({ clientId: CLIENT_ID }),
    ).resolves.toEqual({
      outstandingCents: 0,
      overdueCents: 0,
      openInvoiceCount: 0,
      currency: "gbp",
      country: "GB",
    });
  });

  it("refuses foreign, deleted, or missing clients before querying invoices", async () => {
    const { db, select, conditions } = fakeDb([[]]);
    await expect(
      caller(db).getAccountBalance({ clientId: FOREIGN_CLIENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Client not found" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(conditions[0].sql).toContain('"practices"."deleted_at" is null');
    expect(conditions[0].params).toEqual([PRACTICE_ID]);
    expect(conditions[1].sql).toContain('"clients"."practice_id" =');
    expect(conditions[1].sql).toContain('"clients"."deleted_at" is null');
    expect(conditions[1].params).toEqual([FOREIGN_CLIENT_ID, PRACTICE_ID]);
  });

  it("scopes every invoice to the current practice and exact client, with active adjustments", async () => {
    const { db, conditions, projections, limits } = fakeDb([
      [{ id: CLIENT_ID, currency: "gbp", country: "GB" }],
      Array.from({ length: 125 }, () => ({
        status: "overdue",
        isEstimate: false,
        total: "1.00",
        paidAmount: "0.20",
        adjustedAmount: "0.30",
      })),
    ]);
    await expect(caller(db).getAccountBalance({ clientId: CLIENT_ID }))
      .resolves.toMatchObject({
        outstandingCents: 6_250,
        overdueCents: 6_250,
        openInvoiceCount: 125,
      });

    const invoiceScope = conditions[2];
    expect(invoiceScope.sql).toContain('"invoices"."practice_id" =');
    expect(invoiceScope.sql).toContain('"invoices"."client_id" =');
    expect(invoiceScope.sql).toContain('"invoices"."deleted_at" is null');
    expect(invoiceScope.sql).toContain('"invoices"."is_estimate" =');
    expect(invoiceScope.params).toEqual([PRACTICE_ID, CLIENT_ID, false, "sent", "overdue"]);
    const adjustments = dialect.sqlToQuery(projections[1].adjustedAmount as SQL);
    expect(adjustments.sql).toContain('"invoice_adjustments"."invoice_id" = "invoices"."id"');
    expect(adjustments.sql).toContain('"invoice_adjustments"."deleted_at" is null');
    expect(limits).toEqual([1]);
    expect(Object.keys(projections[1])).toEqual([
      "status", "isEstimate", "total", "paidAmount", "adjustedAmount",
    ]);
  });
});
