import { z } from "zod";
import { eq, and, isNull, ilike, or, sql, desc } from "drizzle-orm";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import { clients, patients } from "@openpims/db";

export const clientsRouter = createRouter({
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        limit: z.number().min(1).max(100).default(25),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions = [
        eq(clients.practiceId, ctx.practiceId),
        isNull(clients.deletedAt),
      ];

      if (input.search) {
        conditions.push(
          or(
            ilike(clients.firstName, `%${input.search}%`),
            ilike(clients.lastName, `%${input.search}%`),
            ilike(clients.email, `%${input.search}%`),
            ilike(clients.phone, `%${input.search}%`)
          )!
        );
      }

      const [items, countResult] = await Promise.all([
        ctx.db
          .select()
          .from(clients)
          .where(and(...conditions))
          .orderBy(desc(clients.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ count: sql<number>`count(*)` })
          .from(clients)
          .where(and(...conditions)),
      ]);

      return {
        items,
        total: Number(countResult[0]?.count ?? 0),
      };
    }),

  search: protectedProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select({
          id: clients.id,
          firstName: clients.firstName,
          lastName: clients.lastName,
          email: clients.email,
          phone: clients.phone,
        })
        .from(clients)
        .where(
          and(
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt),
            or(
              ilike(clients.firstName, `%${input.query}%`),
              ilike(clients.lastName, `%${input.query}%`),
              ilike(clients.email, `%${input.query}%`)
            )
          )
        )
        .limit(10);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [client] = await ctx.db
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.id, input.id),
            eq(clients.practiceId, ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .limit(1);

      if (!client) throw new Error("Client not found");

      const clientPatients = await ctx.db
        .select()
        .from(patients)
        .where(
          and(
            eq(patients.clientId, input.id),
            eq(patients.practiceId, ctx.practiceId),
            isNull(patients.deletedAt)
          )
        );

      return { ...client, patients: clientPatients };
    }),

  create: protectedProcedure
    .input(
      z.object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        notes: z.string().optional(),
        smsConsent: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { smsConsent, ...rest } = input;
      const consent = smsConsent
        ? { smsConsent: true, smsConsentAt: new Date(), smsConsentSource: "intake" }
        : {};
      const [client] = await ctx.db
        .insert(clients)
        .values({ ...rest, ...consent, practiceId: ctx.practiceId })
        .returning();
      return client!;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        firstName: z.string().min(1).optional(),
        lastName: z.string().min(1).optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        notes: z.string().optional(),
        smsConsent: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, smsConsent, ...rest } = input;
      const data: Record<string, unknown> = { ...rest };
      // Record consent transitions with an audit timestamp + source.
      if (smsConsent !== undefined) {
        data.smsConsent = smsConsent;
        if (smsConsent) {
          data.smsConsentAt = new Date();
          data.smsConsentSource = "intake";
        }
      }
      const [client] = await ctx.db
        .update(clients)
        .set(data)
        .where(
          and(
            eq(clients.id, id),
            eq(clients.practiceId, ctx.practiceId)
          )
        )
        .returning();
      return client!;
    }),

  delete: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(clients)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(clients.id, input.id),
            eq(clients.practiceId, ctx.practiceId)
          )
        );
      return { success: true };
    }),
});
