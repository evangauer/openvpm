import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@openpims/db";
import { createRouter, protectedProcedure, type TRPCContext } from "../trpc";
import { sidebarRouter } from "../routers/sidebar";
import { disposableClinic } from "./helpers/disposable-clinic";

const integration = process.env.SIDEBAR_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("personal sidebar persistence", () => {
  it("isolates accounts and practices, serializes devices and preserves viewer restrictions", async () => {
    const f = await disposableClinic();
    vi.stubEnv("HOSTED_MODE", "false");
    try {
      const [p, other] = await f.ownerDb.insert(schema.practices).values([{ name: "Synthetic sidebar" }, { name: "Synthetic isolated" }]).returning();
      const people = await f.ownerDb.insert(schema.users).values([
        { practiceId: p!.id, role: "admin" as const },
        { practiceId: p!.id, role: "viewer" as const },
        { practiceId: other!.id, role: "admin" as const },
      ].map(v => ({ ...v, email: `${randomUUID()}@example.invalid`, name: "Synthetic teammate", passwordHash: "synthetic" }))).returning();
      const router = createRouter({ sidebar: sidebarRouter, forbidden: protectedProcedure.mutation(() => "unexpected") });
      const caller = (user: typeof people[number]) => router.createCaller({ db: f.db, session: { expires: "2099-01-01", user } } as unknown as TRPCContext);
      const scope = (user: typeof people[number]) => ({ practiceId: user.practiceId, userId: user.id });
      const admin = people[0]!, viewer = people[1]!, stranger = people[2]!;
      const a = caller(admin), v = caller(viewer);
      expect(await a.sidebar.get(scope(admin))).toBeNull();
      const imported = { layout: "focused" as const, pinned: ["/inventory"] };
      expect(await a.sidebar.update({ ...scope(admin), command: { kind: "import", preferences: imported } })).toEqual(imported);
      expect(await a.sidebar.update({ ...scope(admin), command: { kind: "import", preferences: { layout: "full", pinned: [] } } })).toEqual(imported);
      await Promise.all([
        a.sidebar.update({ ...scope(admin), command: { kind: "pin", href: "/reports", pinned: true } }),
        caller(admin).sidebar.update({ ...scope(admin), command: { kind: "layout", layout: "full" } }),
      ]);
      expect(await a.sidebar.get(scope(admin))).toEqual({ layout: "full", pinned: ["/inventory", "/reports"] });
      for (const target of [viewer, stranger]) {
        await expect(a.sidebar.get(scope(target))).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(a.sidebar.update({ ...scope(target), command: { kind: "layout", layout: "focused" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(await v.sidebar.get(scope(viewer))).toBeNull();
      await v.sidebar.update({ ...scope(viewer), command: { kind: "layout", layout: "focused" } });
      await expect(v.forbidden()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(v.sidebar.update({ ...scope(viewer), command: { kind: "pin", href: "/reports", pinned: true } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await f.ownerDb.update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, viewer.id));
      await expect(v.sidebar.get(scope(viewer))).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await caller(stranger).sidebar.get(scope(stranger))).toBeNull();
    } finally { vi.unstubAllEnvs(); await f.close(); }
  }, 120_000);
});
