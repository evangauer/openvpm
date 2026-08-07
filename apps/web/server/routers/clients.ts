import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, ilike, or, sql, desc, inArray } from "drizzle-orm";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  appointmentWaitlist,
  appointments,
  clients,
  invoices,
  patients,
  practices,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import { generatePortalAccessToken } from "@/lib/portal/tokens";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { listOffsetInput } from "./pagination";
import {
  CLIENT_ADDRESS_MAX_LENGTH,
  CLIENT_CITY_MAX_LENGTH,
  CLIENT_EMAIL_MAX_LENGTH,
  CLIENT_NAME_MAX_LENGTH,
  CLIENT_PHONE_MAX_LENGTH,
  CLIENT_SEARCH_MAX_LENGTH,
  CLIENT_STATE_MAX_LENGTH,
  CLIENT_ZIP_MAX_LENGTH,
} from "@/lib/clients/policy";

const clientNameInput = z.string().trim().min(1).max(CLIENT_NAME_MAX_LENGTH);
const clientEmailInput = z
  .string()
  .trim()
  .email()
  .max(CLIENT_EMAIL_MAX_LENGTH)
  .optional();
const clientSearchInput = z
  .string()
  .trim()
  .max(CLIENT_SEARCH_MAX_LENGTH)
  .optional();
const clientSearchQueryInput = z
  .string()
  .trim()
  .min(1)
  .max(CLIENT_SEARCH_MAX_LENGTH);
const optionalClientString = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .transform((value) => value || undefined);
const clientAddressInput = optionalClientString(CLIENT_ADDRESS_MAX_LENGTH);
const clientNotesInput = optionalClientString(2000);
const activeSchedulingStatuses = [
  "scheduled",
  "confirmed",
  "checked_in",
  "in_exam",
] as const;
const unresolvedInvoiceStatuses = ["draft", "sent", "overdue"] as const;
const clientManagerProcedure = protectedProcedure.use(
  requireRole("admin", "veterinarian", "technician", "front_desk")
);
type ClientsContext = {
  db: Pick<Database, "select">;
  practiceId: string;
};

function activePracticePredicate(practiceId: string) {
  return sql`exists (
    select 1
    from ${practices}
    where ${practices.id} = ${practiceId}
      and ${practices.deletedAt} is null
  )`;
}

async function assertActivePractice(ctx: ClientsContext) {
  const [practice] = await ctx.db
    .select({ id: practices.id })
    .from(practices)
    .where(and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)))
    .limit(1);

  if (!practice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Practice not found",
    });
  }
}

function canReadPortalAccessTokenRole(role?: string | null): boolean {
  return (
    role === "admin" ||
    role === "veterinarian" ||
    role === "technician" ||
    role === "front_desk"
  );
}

function redactClientPortalAccessToken<T extends { accessToken: string | null }>(
  client: T
): Omit<T, "accessToken"> & { accessToken: null } {
  return { ...client, accessToken: null };
}

export const clientsRouter = createRouter({
  list: protectedProcedure
    .input(
      z.object({
        search: clientSearchInput,
        limit: z.number().int().min(1).max(100).default(25),
        offset: listOffsetInput,
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions = [
        eq(clients.practiceId, ctx.practiceId),
        activePracticePredicate(ctx.practiceId),
        isNull(clients.deletedAt),
      ];

      if (input.search) {
        conditions.push(
          or(
            ilike(clients.firstName, `%${input.search}%`),
            ilike(clients.lastName, `%${input.search}%`),
            ilike(
              sql`concat_ws(' ', ${clients.firstName}, ${clients.lastName})`,
              `%${input.search}%`
            ),
            ilike(clients.email, `%${input.search}%`),
            ilike(clients.phone, `%${input.search}%`)
          )!
        );
      }

      const [items, countResult, practiceResult] = await Promise.all([
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
        ctx.db
          .select({ timezone: practices.timezone })
          .from(practices)
          .where(
            and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt))
          )
          .limit(1),
      ]);

      if (!practiceResult[0]) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Practice not found",
        });
      }

      return {
        items: items.map(redactClientPortalAccessToken),
        total: Number(countResult[0]?.count ?? 0),
        timezone: practiceResult[0].timezone ?? null,
      };
    }),

  search: protectedProcedure
    .input(z.object({ query: clientSearchQueryInput }))
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
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt),
            or(
              ilike(clients.firstName, `%${input.query}%`),
              ilike(clients.lastName, `%${input.query}%`),
              ilike(
                sql`concat_ws(' ', ${clients.firstName}, ${clients.lastName})`,
                `%${input.query}%`
              ),
              ilike(clients.email, `%${input.query}%`),
              ilike(clients.phone, `%${input.query}%`)
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
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .limit(1);

      if (!client) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
      }

      const clientPatients = await ctx.db
        .select()
        .from(patients)
        .where(
          and(
            eq(patients.clientId, input.id),
            eq(patients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(patients.deletedAt)
          )
        );

      const safeClient = canReadPortalAccessTokenRole(ctx.user.role)
        ? client
        : redactClientPortalAccessToken(client);

      return {
        ...safeClient,
        patients: clientPatients,
      };
    }),

  create: clientManagerProcedure
    .input(
      z.object({
        firstName: clientNameInput,
        lastName: clientNameInput,
        email: clientEmailInput,
        phone: optionalClientString(CLIENT_PHONE_MAX_LENGTH),
        address: clientAddressInput,
        city: optionalClientString(CLIENT_CITY_MAX_LENGTH),
        state: optionalClientString(CLIENT_STATE_MAX_LENGTH),
        zip: optionalClientString(CLIENT_ZIP_MAX_LENGTH),
        notes: clientNotesInput,
        smsConsent: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertActivePractice(ctx);
      const { smsConsent, ...rest } = input;
      const consent = smsConsent
        ? { smsConsent: true, smsConsentAt: new Date(), smsConsentSource: "intake" }
        : {};
      const [client] = await ctx.db
        .insert(clients)
        .values({
          ...rest,
          ...consent,
          practiceId: ctx.practiceId,
          accessToken: generatePortalAccessToken(),
        })
        .returning();
      await dispatchWebhookEvent(ctx.practiceId, "client.created", {
        id: client!.id,
        firstName: client!.firstName,
        lastName: client!.lastName,
        email: client!.email,
        phone: client!.phone,
        source: "dashboard",
      });
      return client!;
    }),

  update: clientManagerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        firstName: clientNameInput.optional(),
        lastName: clientNameInput.optional(),
        email: clientEmailInput,
        phone: optionalClientString(CLIENT_PHONE_MAX_LENGTH),
        address: clientAddressInput,
        city: optionalClientString(CLIENT_CITY_MAX_LENGTH),
        state: optionalClientString(CLIENT_STATE_MAX_LENGTH),
        zip: optionalClientString(CLIENT_ZIP_MAX_LENGTH),
        notes: clientNotesInput,
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
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .returning();
      if (!client) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
      }
      return client;
    }),

  rotatePortalAccessToken: clientManagerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const [client] = await ctx.db
        .update(clients)
        .set({ accessToken: generatePortalAccessToken() })
        .where(
          and(
            eq(clients.id, input.id),
            eq(clients.practiceId, ctx.practiceId),
            activePracticePredicate(ctx.practiceId),
            isNull(clients.deletedAt)
          )
        )
        .returning({
          id: clients.id,
          accessToken: clients.accessToken,
        });

      if (!client) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
      }

      return client;
    }),

  delete: protectedProcedure
    .use(requireRole("admin"))
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const [existingClient] = await tx
          .select({ id: clients.id })
          .from(clients)
          .where(
            and(
              eq(clients.id, input.id),
              eq(clients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(clients.deletedAt)
            )
          )
          .limit(1);

        if (!existingClient) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
        }

        const [activePatient] = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(
            and(
              eq(patients.clientId, input.id),
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(patients.deletedAt)
            )
          )
          .limit(1);

        if (activePatient) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot delete a client with active patients.",
          });
        }

        const [activeAppointment] = await tx
          .select({ id: appointments.id })
          .from(appointments)
          .where(
            and(
              eq(appointments.clientId, input.id),
              eq(appointments.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(appointments.deletedAt),
              inArray(appointments.status, activeSchedulingStatuses)
            )
          )
          .limit(1);

        if (activeAppointment) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete a client with active appointments. Cancel or complete the appointments first.",
          });
        }

        const [waitingEntry] = await tx
          .select({ id: appointmentWaitlist.id })
          .from(appointmentWaitlist)
          .where(
            and(
              eq(appointmentWaitlist.clientId, input.id),
              eq(appointmentWaitlist.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              eq(appointmentWaitlist.status, "waiting"),
              isNull(appointmentWaitlist.deletedAt)
            )
          )
          .limit(1);

        if (waitingEntry) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete a client with waiting appointment requests. Resolve the waitlist first.",
          });
        }

        const [unresolvedInvoice] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              eq(invoices.clientId, input.id),
              eq(invoices.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(invoices.deletedAt),
              inArray(invoices.status, unresolvedInvoiceStatuses)
            )
          )
          .limit(1);

        if (unresolvedInvoice) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Cannot delete a client with draft, sent, or overdue invoices. Resolve the invoices first.",
          });
        }

        const [client] = await tx
          .update(clients)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(clients.id, input.id),
              eq(clients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(clients.deletedAt)
            )
          )
          .returning({ id: clients.id });
        if (!client) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
        }
      });
      return { success: true };
    }),
});
