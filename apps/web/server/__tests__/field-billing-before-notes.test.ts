import { afterEach, describe, expect, it, vi } from "vitest";
import { assertVisitInvoiceReadyForFinancialAction } from "../visit-billing-integrity";
import { PgDialect } from "drizzle-orm/pg-core";
const practiceId = "00000000-0000-0000-0000-0000000000aa";
const appointmentId = "00000000-0000-0000-0000-000000000001";
function context(results: unknown[][], unresolved = false) {
  const predicates: unknown[] = [];
  const select = vi.fn(() => {
    const chain: any = {};
    for (const method of ["from", "innerJoin"]) chain[method] = () => chain;
    chain.where = (predicate: unknown) => {
      predicates.push(predicate);
      return chain;
    };
    chain.limit = async () => results.shift() ?? [];
    return chain;
  });
  const execute = vi.fn(async (statement: any) => {
    const sql = new PgDialect().sqlToQuery(statement).sql;
    return unresolved && sql.includes("left join")
      ? [{ id: "unresolved" }]
      : [];
  });
  const db: any = {
    select,
    execute,
    transaction: (run: (db: any) => unknown) => run(db),
  };
  return { ctx: { db, practiceId }, select, execute, predicates };
}
afterEach(() => vi.unstubAllEnvs());
describe("field billing before notes", () => {
  it("retains the clinical signing requirement when rollout is off", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "false");
    const { ctx, select, execute } = context([[{ status: "draft" }]]);
    await expect(
      assertVisitInvoiceReadyForFinancialAction(ctx, appointmentId),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([{ target: [] }, { target: [{ settings: {} }] }])(
    "rejects non-field, terminal, deleted or disabled targets",
    async ({ target }) => {
      vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
      const { ctx } = context([[{ status: "draft" }], target]);
      await expect(
        assertVisitInvoiceReadyForFinancialAction(ctx, appointmentId),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    },
  );
  it("permits an enabled open field visit only after syncing and reconciling work", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
    const { ctx, execute, predicates } = context([
      [],
      [{ settings: { ambulatoryWorkspace: { enabled: true } } }],
    ]);
    await expect(
      assertVisitInvoiceReadyForFinancialAction(ctx, appointmentId),
    ).resolves.toBeUndefined();
    expect(execute.mock.calls.length).toBeGreaterThan(1);
    const query = new PgDialect().sqlToQuery(predicates[1] as never);
    expect(query.params).toEqual(
      expect.arrayContaining([practiceId, appointmentId, "field", "in_exam"]),
    );
    expect(query.sql).toContain('"appointments"."deleted_at" is null');
  });
  it("still refuses payment when a performed item needs charge reconciliation", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
    const { ctx } = context(
      [
        [{ status: "draft" }],
        [{ settings: { ambulatoryWorkspace: { enabled: true } } }],
      ],
      true,
    );
    await expect(
      assertVisitInvoiceReadyForFinancialAction(ctx, appointmentId),
    ).rejects.toThrow("Resolve every performed");
  });
});
