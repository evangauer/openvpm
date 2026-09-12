import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardRouter } from "../routers/dashboard";
import { PgDialect } from "drizzle-orm/pg-core";

const practiceId = "00000000-0000-0000-0000-0000000000aa";
function setup(results: unknown[][]) {
  const predicates: unknown[] = [];
  const offsets: number[] = [];
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const chain: any = {};
    for (const name of ["from", "innerJoin", "orderBy", "limit"])
      chain[name] = () => chain;
    chain.where = (value: unknown) => {
      predicates.push(value);
      return chain;
    };
    chain.offset = (value: number) => {
      offsets.push(value);
      return chain;
    };
    chain.then = (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  });
  const db: any = {
    select,
    execute: vi.fn(),
    transaction: (run: (db: any) => unknown) => run(db),
  };
  const caller = dashboardRouter.createCaller({
    db,
    session: {
      user: {
        id: "00000000-0000-0000-0000-000000000001",
        email: "synthetic@example.test",
        name: "Synthetic",
        role: "admin",
        practiceId,
      },
    },
  } as never);
  return { caller, select, predicates, offsets };
}
afterEach(() => vi.unstubAllEnvs());
describe("unfinished field visits", () => {
  it("does not query clinical data while the platform gate is off", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "false");
    const { caller, select } = setup([]);
    expect(await caller.unfinishedFieldVisits({})).toEqual({
      enabled: false,
      items: [],
      hasMore: false,
    });
    expect(select).not.toHaveBeenCalled();
  });
  it("does not expose the queue to a practice that has not enabled it", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
    const { caller, select } = setup([[{ settings: {} }]]);
    expect((await caller.unfinishedFieldVisits({})).enabled).toBe(false);
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("rejects a missing practice and invalid page bounds", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
    await expect(
      setup([[]]).caller.unfinishedFieldVisits({}),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      setup([]).caller.unfinishedFieldVisits({ offset: -1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("paginates unfinished field encounters across days without depending on payment or recent viewing", async () => {
    vi.stubEnv("AMBULATORY_WORKSPACE_ENABLED", "true");
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: String(i),
      patientName: `Animal ${i}`,
      startTime: new Date(),
    }));
    const { caller, offsets, predicates } = setup([
      [{ settings: { ambulatoryWorkspace: { enabled: true } } }],
      rows,
    ]);
    const result = await caller.unfinishedFieldVisits({ offset: 20 });
    expect(result.items).toEqual(rows.slice(0, 20));
    expect(result.hasMore).toBe(true);
    expect(offsets).toEqual([20]);
    const query = new PgDialect().sqlToQuery(predicates[1] as never);
    expect(query.params).toContain(practiceId);
    expect(query.params).toContain("field");
    expect(query.params).toContain("in_exam");
    expect(query.sql).toContain('"appointments"."deleted_at" is null');
    expect(query.sql).not.toMatch(/invoice|recent_clinical|start_time/);
  });
});
