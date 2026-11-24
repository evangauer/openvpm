import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { users } from "@openpims/db";
import { createRouter, protectedProcedure } from "../trpc";
import { availableNavigation, TOOL_PATHS } from "@/lib/navigation";
import { parseSidebarPreferences, type SidebarPreferences } from "@/lib/sidebar-pins";

const scope = z.object({ practiceId: z.string().uuid(), userId: z.string().uuid() }).strict();
const preferences = z.object({
  layout: z.enum(["full", "focused"]),
  pinned: z.array(z.string().max(100)).max(32),
}).strict();
const command = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("import"), preferences }).strict(),
  z.object({ kind: z.literal("layout"), layout: z.enum(["full", "focused"]) }).strict(),
  z.object({ kind: z.literal("pin"), href: z.string().max(100), pinned: z.boolean() }).strict(),
]);

function ownScope(input: z.infer<typeof scope>, practiceId: string, userId: string) {
  // Scope is a cache/race guard, never an authority supplied by the client.
  if (input.practiceId !== practiceId || input.userId !== userId) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Sidebar account changed." });
  }
  return and(eq(users.practiceId, practiceId), eq(users.id, userId), isNull(users.deletedAt));
}

export const sidebarRouter = createRouter({
  get: protectedProcedure.input(scope).query(async ({ ctx, input }) => {
    const [user] = await ctx.db.select({ preferences: users.sidebarPreferences }).from(users)
      .where(ownScope(input, ctx.practiceId, ctx.user.id)).limit(1);
    if (!user) throw new TRPCError({ code: "NOT_FOUND" });
    return user.preferences === null ? null : parseSidebarPreferences(JSON.stringify(user.preferences));
  }),
  update: protectedProcedure.input(scope.extend({ command })).mutation(async ({ ctx, input }) => {
    const where = ownScope(input, ctx.practiceId, ctx.user.id);
    // Serialize edits across devices; a pin edit never overwrites a layout or
    // a different pin read by another device. First legacy import wins once.
    const [user] = await ctx.db.select({ preferences: users.sidebarPreferences }).from(users)
      .where(where).for("update").limit(1);
    if (!user) throw new TRPCError({ code: "NOT_FOUND" });
    let next: SidebarPreferences = parseSidebarPreferences(JSON.stringify(user.preferences));
    const allowed = new Set(availableNavigation(ctx.user.role, true).map(item => item.href));
    if (input.command.kind === "import") {
      if (user.preferences !== null) return next;
      next = { ...input.command.preferences, pinned: [...new Set(input.command.preferences.pinned)]
        .filter(href => TOOL_PATHS.includes(href) && allowed.has(href)) };
    } else if (input.command.kind === "layout") {
      next.layout = input.command.layout;
    } else {
      const { href, pinned } = input.command;
      if (!TOOL_PATHS.includes(href) || (pinned && !allowed.has(href))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Sidebar tool is unavailable." });
      }
      next.pinned = next.pinned.filter(item => item !== href);
      if (pinned) next.pinned.push(href);
    }
    await ctx.db.update(users).set({ sidebarPreferences: { version: 1, ...next } }).where(where);
    return next;
  }),
});
