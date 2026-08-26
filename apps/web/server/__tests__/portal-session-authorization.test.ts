import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRouter, portalProcedure } from "../trpc";

const router = createRouter({
  read: portalProcedure.input(z.object({})).query(() => ({ ok: true })),
  write: portalProcedure.input(z.object({})).mutation(() => ({ ok: true })),
});

function unresolvedDb() {
  const builder: Record<string, unknown> = {};
  builder.from = () => builder;
  builder.innerJoin = () => builder;
  builder.where = () => ({ limit: async () => [] });
  const db: Record<string, unknown> = {
    select: () => builder,
    execute: async () => undefined,
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return db;
}

function transactionDb() {
  const db: Record<string, unknown> = { execute: async () => undefined };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return db;
}

const portalClient = {
  id: "00000000-0000-0000-0000-000000000001",
  practiceId: "00000000-0000-0000-0000-000000000002",
  firstName: "Portal",
  lastName: "Client",
  email: "portal@example.test",
  phone: null,
};

describe("portal procedure session boundary", () => {
  it("rejects requests without a resolvable browser session", async () => {
    const caller = router.createCaller({
      db: unresolvedDb(),
      portalSessionToken: null,
    } as never);
    await expect(caller.read({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Portal session expired",
    });
  });

  it("rejects cross-origin portal mutations even with an active session", async () => {
    const caller = router.createCaller({
      db: transactionDb(),
      portalClient,
      portalSessionId: "session-id",
      requestOrigin: "https://attacker.example",
      requestUrlOrigin: "https://portal.example",
    } as never);
    await expect(caller.write({})).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Invalid request origin",
    });
  });
});
