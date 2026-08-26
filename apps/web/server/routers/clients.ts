import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  eq,
  and,
  isNull,
  or,
  sql,
  desc,
  inArray,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  appointmentWaitlist,
  appointments,
  clients,
  invoices,
  patients,
  portalSessions,
  practices,
  smsConsentEvents,
  smsSuppressions,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import {
  generatePortalAccessToken,
  hashPortalAccessToken,
  PORTAL_ACCESS_TOKEN_TTL_MS,
} from "@/lib/portal/tokens";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatcher";
import { listOffsetInput } from "./pagination";
import {
  CLIENT_ADDRESS_MAX_LENGTH,
  CLIENT_CITY_MAX_LENGTH,
  CLIENT_CONTACT_METHODS,
  CLIENT_EMAIL_MAX_LENGTH,
  CLIENT_NAME_MAX_LENGTH,
  CLIENT_PHONE_MAX_LENGTH,
  CLIENT_SEARCH_MAX_LENGTH,
  CLIENT_STATE_MAX_LENGTH,
  CLIENT_ZIP_MAX_LENGTH,
} from "@/lib/clients/policy";
import { normalizeE164 } from "@/lib/messaging/phone";
import {
  phoneNumbersMatchForConsent,
  SMS_CONSENT_DISCLOSURE,
} from "@/lib/messaging/consent";
import {
  acquireSmsRecipientLockInTransaction,
  revokeSmsConsentAfterRecipientLockInTransaction,
} from "@/lib/messaging/suppression";
import {
  appendRequiredSmsConsentEventInTransaction,
  staffSmsConsentEventKey,
} from "@/lib/messaging/consent-events";
import { recordActivationAfterClientCreated } from "@/lib/funnel-events-server";
import { clientSearchContainsPattern } from "@/lib/clients/search";

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
const clientPreferredContactInput = z.enum(CLIENT_CONTACT_METHODS);
const normalizedClientPhoneInput = z
  .string()
  .trim()
  .max(CLIENT_PHONE_MAX_LENGTH)
  .transform((value, ctx) => {
    const normalized = normalizeE164(value);
    if (!normalized) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A valid SMS phone number is required",
      });
      return z.NEVER;
    }
    return normalized;
  });
const activeSchedulingStatuses = [
  "scheduled",
  "confirmed",
  "checked_in",
  "in_exam",
] as const;
const unresolvedInvoiceStatuses = ["draft", "sent", "overdue"] as const;
const clientManagerProcedure = protectedProcedure.use(
  requireRole("admin", "veterinarian", "technician", "front_desk"),
);
type ClientsContext = {
  db: Pick<Database, "select">;
  practiceId: string;
};

function literalClientSearchMatch(column: SQLWrapper, value: string): SQL {
  const pattern = clientSearchContainsPattern(value);
  return sql`${column} ilike ${pattern} escape '\\'`;
}

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

function smsSuppressionConsentError(reason: string): TRPCError {
  if (reason === "manual") {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This number was manually placed on the do-not-text list. A staff member must review it before any future opt-in.",
    });
  }
  if (reason === "stop") {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This number previously opted out by text. The client must reply START from that phone before SMS consent can be restored.",
    });
  }
  return new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      "This number is blocked from texting after a delivery or complaint event. Review the suppression before recording consent.",
  });
}

function hasCompleteSmsConsentEvidence(state: {
  smsConsent: boolean;
  smsConsentAt?: Date | null;
  smsConsentSource?: string | null;
  smsConsentDisclosure?: string | null;
}): boolean {
  return Boolean(
    state.smsConsent &&
    state.smsConsentAt &&
    state.smsConsentSource?.trim() &&
    state.smsConsentDisclosure?.trim(),
  );
}

function smsPreferredContactError(): TRPCError {
  return new TRPCError({
    code: "BAD_REQUEST",
    message:
      "Text message can be the preferred contact only after a valid mobile phone number and complete SMS consent are saved.",
  });
}

function redactClientPortalAccessToken<
  T extends { accessToken: string | null },
>(client: T): Omit<T, "accessToken"> & { accessToken: null } {
  return { ...client, accessToken: null };
}

export const clientsRouter = createRouter({
  list: protectedProcedure
    .input(
      z.object({
        search: clientSearchInput,
        limit: z.number().int().min(1).max(100).default(25),
        offset: listOffsetInput,
      }),
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
            literalClientSearchMatch(clients.firstName, input.search),
            literalClientSearchMatch(clients.lastName, input.search),
            literalClientSearchMatch(
              sql`concat_ws(' ', ${clients.firstName}, ${clients.lastName})`,
              input.search,
            ),
            literalClientSearchMatch(clients.email, input.search),
            literalClientSearchMatch(clients.phone, input.search),
          )!,
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
            and(eq(practices.id, ctx.practiceId), isNull(practices.deletedAt)),
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
              literalClientSearchMatch(clients.firstName, input.query),
              literalClientSearchMatch(clients.lastName, input.query),
              literalClientSearchMatch(
                sql`concat_ws(' ', ${clients.firstName}, ${clients.lastName})`,
                input.query,
              ),
              literalClientSearchMatch(clients.email, input.query),
              literalClientSearchMatch(clients.phone, input.query),
            ),
          ),
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
            isNull(clients.deletedAt),
          ),
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
            isNull(patients.deletedAt),
          ),
        );

      const normalizedClientPhone = normalizeE164(client.phone);
      const smsConsentHistory = await ctx.db
        .select({
          id: smsConsentEvents.id,
          action: smsConsentEvents.action,
          destinationE164: smsConsentEvents.destinationE164,
          source: smsConsentEvents.source,
          detail: smsConsentEvents.detail,
          actorType: smsConsentEvents.actorType,
          actorName: smsConsentEvents.actorName,
          provider: smsConsentEvents.provider,
          occurredAt: smsConsentEvents.occurredAt,
        })
        .from(smsConsentEvents)
        .where(
          and(
            eq(smsConsentEvents.practiceId, ctx.practiceId),
            normalizedClientPhone
              ? or(
                  eq(smsConsentEvents.clientId, input.id),
                  eq(smsConsentEvents.destinationE164, normalizedClientPhone),
                )
              : eq(smsConsentEvents.clientId, input.id),
            activePracticePredicate(ctx.practiceId),
          ),
        )
        .orderBy(desc(smsConsentEvents.occurredAt), desc(smsConsentEvents.id))
        .limit(50);

      const safeClient = redactClientPortalAccessToken(client);
      const portalAccessState = !client.accessToken
        ? "not_issued"
        : client.portalAccessTokenUsedAt
          ? "consumed"
          : client.portalAccessTokenExpiresAt &&
              client.portalAccessTokenExpiresAt.getTime() > Date.now()
            ? "ready"
            : "expired";

      return {
        ...safeClient,
        portalAccessState,
        patients: clientPatients,
        smsConsentHistory,
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
        preferredContactMethod: clientPreferredContactInput.optional(),
        smsConsent: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { smsConsent, preferredContactMethod, ...rest } = input;
      const normalizedPhone = normalizeE164(rest.phone);
      if (smsConsent && !normalizedPhone) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A valid mobile phone number is required for SMS consent",
        });
      }
      if (
        preferredContactMethod === "sms" &&
        (!smsConsent || !normalizedPhone)
      ) {
        throw smsPreferredContactError();
      }

      await assertActivePractice(ctx);
      const consent = smsConsent
        ? {
            smsConsent: true,
            smsConsentAt: new Date(),
            smsConsentSource: SMS_CONSENT_DISCLOSURE.source,
            smsConsentDisclosure: SMS_CONSENT_DISCLOSURE.snapshot,
          }
        : {};
      const client = await ctx.db.transaction(async (tx) => {
        if (smsConsent && normalizedPhone) {
          await acquireSmsRecipientLockInTransaction(
            tx,
            ctx.practiceId,
            normalizedPhone,
          );
          const [suppression] = await tx
            .select({ reason: smsSuppressions.reason })
            .from(smsSuppressions)
            .where(
              and(
                eq(smsSuppressions.practiceId, ctx.practiceId),
                eq(smsSuppressions.phone, normalizedPhone),
              ),
            )
            .limit(1);
          if (suppression) {
            throw smsSuppressionConsentError(suppression.reason);
          }
        }

        const [created] = await tx
          .insert(clients)
          .values({
            ...rest,
            ...(preferredContactMethod ? { preferredContactMethod } : {}),
            ...consent,
            practiceId: ctx.practiceId,
            accessToken: null,
          })
          .returning();
        if (!created) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Client could not be created",
          });
        }

        if (smsConsent && normalizedPhone) {
          await appendRequiredSmsConsentEventInTransaction(tx, {
            practiceId: ctx.practiceId,
            clientId: created.id,
            destinationE164: normalizedPhone,
            action: "granted",
            source: SMS_CONSENT_DISCLOSURE.source,
            disclosureVersion: SMS_CONSENT_DISCLOSURE.version,
            disclosure: SMS_CONSENT_DISCLOSURE.snapshot,
            detail:
              "Staff recorded affirmative consent while creating the client.",
            actorType: "staff",
            actorUserId: ctx.user.id,
            actorName: ctx.user.name,
            eventKey: staffSmsConsentEventKey(),
          });
        }

        return created;
      });
      await recordActivationAfterClientCreated(
        ctx.db,
        ctx.practiceId,
        "clients.create",
      );
      await dispatchWebhookEvent(ctx.practiceId, "client.created", {
        id: client.id,
        firstName: client.firstName,
        lastName: client.lastName,
        email: client.email,
        phone: client.phone,
        source: "dashboard",
      });
      return client;
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
        preferredContactMethod: clientPreferredContactInput.optional(),
        smsConsent: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const phoneWasProvided = Object.prototype.hasOwnProperty.call(
          input,
          "phone",
        );
        const { id, smsConsent, phone, preferredContactMethod, ...rest } =
          input;
        const data: Record<string, unknown> = {
          ...rest,
          ...(preferredContactMethod ? { preferredContactMethod } : {}),
        };

        if (phoneWasProvided) {
          // Drizzle ignores undefined values. Use null so an explicitly cleared
          // phone field is actually removed from the client record.
          data.phone = phone ?? null;
        }

        if (
          phoneWasProvided ||
          smsConsent !== undefined ||
          preferredContactMethod === "sms"
        ) {
          // Read without a row lock only to derive recipient advisory keys.
          // Hosted sends use advisory -> client row, so consent transitions use
          // the same order and then revalidate the row after acquiring locks.
          const [prelockClient] = await tx
            .select({
              phone: clients.phone,
              smsConsent: clients.smsConsent,
              smsConsentAt: clients.smsConsentAt,
              smsConsentSource: clients.smsConsentSource,
              smsConsentDisclosure: clients.smsConsentDisclosure,
              preferredContactMethod: clients.preferredContactMethod,
            })
            .from(clients)
            .where(
              and(
                eq(clients.id, id),
                eq(clients.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(clients.deletedAt),
              ),
            )
            .limit(1);
          if (!prelockClient) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Client not found",
            });
          }

          const prelockNextPhone = phoneWasProvided
            ? phone
            : prelockClient.phone;
          const prelockPhoneChanged = !phoneNumbersMatchForConsent(
            prelockClient.phone,
            prelockNextPhone,
          );
          const oldDestination = normalizeE164(prelockClient.phone);
          const newDestination = normalizeE164(prelockNextPhone);
          const lockDestinations = new Set<string>();
          if (
            oldDestination &&
            (smsConsent === false ||
              (prelockClient.smsConsent && prelockPhoneChanged))
          ) {
            lockDestinations.add(oldDestination);
          }
          if (smsConsent === true && newDestination) {
            lockDestinations.add(newDestination);
          }
          if (preferredContactMethod === "sms" && newDestination) {
            lockDestinations.add(newDestination);
          }
          for (const destination of [...lockDestinations].sort()) {
            await acquireSmsRecipientLockInTransaction(
              tx,
              ctx.practiceId,
              destination,
            );
          }

          const [existingClient] = await tx
            .select({
              id: clients.id,
              phone: clients.phone,
              smsConsent: clients.smsConsent,
              smsConsentAt: clients.smsConsentAt,
              smsConsentSource: clients.smsConsentSource,
              smsConsentDisclosure: clients.smsConsentDisclosure,
              preferredContactMethod: clients.preferredContactMethod,
            })
            .from(clients)
            .where(
              and(
                eq(clients.id, id),
                eq(clients.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(clients.deletedAt),
              ),
            )
            .limit(1)
            .for("update");

          if (!existingClient) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Client not found",
            });
          }

          if (
            !phoneNumbersMatchForConsent(
              existingClient.phone,
              prelockClient.phone,
            ) ||
            existingClient.smsConsent !== prelockClient.smsConsent
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "Client SMS consent or phone changed while saving. Refresh and try again.",
            });
          }

          const nextPhone = phoneWasProvided ? phone : existingClient.phone;
          const phoneChanged = !phoneNumbersMatchForConsent(
            existingClient.phone,
            nextPhone,
          );
          let nextConsentState = {
            smsConsent: existingClient.smsConsent,
            smsConsentAt: existingClient.smsConsentAt,
            smsConsentSource: existingClient.smsConsentSource,
            smsConsentDisclosure: existingClient.smsConsentDisclosure,
          };

          if (smsConsent === true) {
            const normalizedNextPhone = normalizeE164(nextPhone);
            if (!normalizedNextPhone) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message:
                  "A valid mobile phone number is required for SMS consent",
              });
            }

            const [suppression] = await tx
              .select({ reason: smsSuppressions.reason })
              .from(smsSuppressions)
              .where(
                and(
                  eq(smsSuppressions.practiceId, ctx.practiceId),
                  eq(smsSuppressions.phone, normalizedNextPhone),
                ),
              )
              .limit(1);
            if (suppression) {
              throw smsSuppressionConsentError(suppression.reason);
            }

            if (phoneChanged && existingClient.smsConsent && oldDestination) {
              await appendRequiredSmsConsentEventInTransaction(tx, {
                practiceId: ctx.practiceId,
                clientId: id,
                destinationE164: oldDestination,
                action: "revoked",
                source: "phone_change:v1",
                detail:
                  "Prior SMS consent was invalidated because the client destination changed.",
                actorType: "staff",
                actorUserId: ctx.user.id,
                actorName: ctx.user.name,
                eventKey: staffSmsConsentEventKey(),
              });
            }

            await appendRequiredSmsConsentEventInTransaction(tx, {
              practiceId: ctx.practiceId,
              clientId: id,
              destinationE164: normalizedNextPhone,
              action: "granted",
              source: SMS_CONSENT_DISCLOSURE.source,
              disclosureVersion: SMS_CONSENT_DISCLOSURE.version,
              disclosure: SMS_CONSENT_DISCLOSURE.snapshot,
              detail:
                "Staff recorded affirmative consent on the client record.",
              actorType: "staff",
              actorUserId: ctx.user.id,
              actorName: ctx.user.name,
              eventKey: staffSmsConsentEventKey(),
            });

            // A true value is an explicit staff attestation under the current,
            // server-owned disclosure. Unrelated edits omit this field entirely.
            data.smsConsent = true;
            data.smsConsentAt = new Date();
            data.smsConsentSource = SMS_CONSENT_DISCLOSURE.source;
            data.smsConsentDisclosure = SMS_CONSENT_DISCLOSURE.snapshot;
            nextConsentState = {
              smsConsent: true,
              smsConsentAt: data.smsConsentAt as Date,
              smsConsentSource: SMS_CONSENT_DISCLOSURE.source,
              smsConsentDisclosure: SMS_CONSENT_DISCLOSURE.snapshot,
            };
          } else if (phoneChanged || smsConsent === false) {
            if (smsConsent === false) {
              if (oldDestination) {
                await revokeSmsConsentAfterRecipientLockInTransaction(tx, {
                  practiceId: ctx.practiceId,
                  phone: oldDestination,
                  reason: "manual",
                  detail: `Staff revoked SMS consent from client ${id}.`,
                  evidence: {
                    clientId: id,
                    source: "staff_manual_revoke:v1",
                    detail: "Staff explicitly withdrew SMS consent.",
                    actorType: "staff",
                    actorUserId: ctx.user.id,
                    actorName: ctx.user.name,
                    eventKey: staffSmsConsentEventKey(),
                  },
                });
              }
            } else if (existingClient.smsConsent && oldDestination) {
              await appendRequiredSmsConsentEventInTransaction(tx, {
                practiceId: ctx.practiceId,
                clientId: id,
                destinationE164: oldDestination,
                action: "revoked",
                source: "phone_change:v1",
                detail:
                  "Prior SMS consent was invalidated because the client destination changed.",
                actorType: "staff",
                actorUserId: ctx.user.id,
                actorName: ctx.user.name,
                eventKey: staffSmsConsentEventKey(),
              });
            }
            // Consent belongs to one destination. Changing that destination (or
            // explicitly withdrawing consent) invalidates all prior evidence.
            data.smsConsent = false;
            data.smsConsentAt = null;
            data.smsConsentSource = null;
            data.smsConsentDisclosure = null;
            nextConsentState = {
              smsConsent: false,
              smsConsentAt: null,
              smsConsentSource: null,
              smsConsentDisclosure: null,
            };
          }

          const nextPreferredContactMethod =
            preferredContactMethod ??
            existingClient.preferredContactMethod ??
            "phone";
          if (
            nextPreferredContactMethod === "sms" &&
            (!normalizeE164(nextPhone) ||
              !hasCompleteSmsConsentEvidence(nextConsentState))
          ) {
            throw smsPreferredContactError();
          }
        }

        const [client] = await tx
          .update(clients)
          .set(data)
          .where(
            and(
              eq(clients.id, id),
              eq(clients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(clients.deletedAt),
            ),
          )
          .returning();
        if (!client) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Client not found",
          });
        }
        return client;
      });
    }),

  /** Practice-wide do-not-text action for every active client sharing a phone. */
  revokeSms: clientManagerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        expectedPhone: normalizedClientPhoneInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [prelockClient] = await tx
          .select({ phone: clients.phone })
          .from(clients)
          .where(
            and(
              eq(clients.id, input.id),
              eq(clients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(clients.deletedAt),
            ),
          )
          .limit(1);
        if (!prelockClient) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Client not found",
          });
        }
        const prelockPhone = normalizeE164(prelockClient.phone);
        if (!prelockPhone) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Client does not have a valid SMS phone number on file",
          });
        }
        if (prelockPhone !== input.expectedPhone) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "The saved client phone no longer matches this page. Refresh before revoking SMS.",
          });
        }

        try {
          await acquireSmsRecipientLockInTransaction(
            tx,
            ctx.practiceId,
            prelockPhone,
          );
          const [lockedClient] = await tx
            .select({ phone: clients.phone })
            .from(clients)
            .where(
              and(
                eq(clients.id, input.id),
                eq(clients.practiceId, ctx.practiceId),
                activePracticePredicate(ctx.practiceId),
                isNull(clients.deletedAt),
              ),
            )
            .limit(1)
            .for("update");
          if (!lockedClient) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Client not found",
            });
          }
          if (normalizeE164(lockedClient.phone) !== prelockPhone) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "Client phone changed while revoking SMS. Refresh and try again.",
            });
          }
          return await revokeSmsConsentAfterRecipientLockInTransaction(tx, {
            practiceId: ctx.practiceId,
            phone: prelockPhone,
            reason: "manual",
            detail: `Staff revoked SMS consent from client ${input.id}.`,
            evidence: {
              clientId: input.id,
              source: "staff_manual_revoke:v1",
              detail: "Staff explicitly withdrew SMS consent practice-wide.",
              actorType: "staff",
              actorUserId: ctx.user.id,
              actorName: ctx.user.name,
              eventKey: staffSmsConsentEventKey(),
            },
          });
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          console.error("Manual SMS revocation failed", error);
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message:
              "SMS consent could not be revoked safely. No message was sent.",
          });
        }
      });
    }),

  rotatePortalAccessToken: clientManagerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rawToken = generatePortalAccessToken();
      const now = new Date();
      const client = await ctx.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(clients)
          .set({
            accessToken: hashPortalAccessToken(rawToken),
            portalAccessTokenExpiresAt: new Date(
              now.getTime() + PORTAL_ACCESS_TOKEN_TTL_MS,
            ),
            portalAccessTokenUsedAt: null,
          })
          .where(
            and(
              eq(clients.id, input.id),
              eq(clients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(clients.deletedAt),
            ),
          )
          .returning({ id: clients.id });

        if (!updated) return null;

        await tx
          .update(portalSessions)
          .set({ revokedAt: now, revokedReason: "staff_access_reset" })
          .where(
            and(
              eq(portalSessions.clientId, updated.id),
              eq(portalSessions.practiceId, ctx.practiceId),
              isNull(portalSessions.revokedAt),
            ),
          );
        return updated;
      });

      if (!client) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Client not found" });
      }

      return { id: client.id, accessToken: rawToken };
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
              isNull(clients.deletedAt),
            ),
          )
          .limit(1);

        if (!existingClient) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Client not found",
          });
        }

        const [activePatient] = await tx
          .select({ id: patients.id })
          .from(patients)
          .where(
            and(
              eq(patients.clientId, input.id),
              eq(patients.practiceId, ctx.practiceId),
              activePracticePredicate(ctx.practiceId),
              isNull(patients.deletedAt),
            ),
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
              inArray(appointments.status, activeSchedulingStatuses),
            ),
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
              isNull(appointmentWaitlist.deletedAt),
            ),
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
              inArray(invoices.status, unresolvedInvoiceStatuses),
            ),
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
              isNull(clients.deletedAt),
            ),
          )
          .returning({ id: clients.id });
        if (!client) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Client not found",
          });
        }
      });
      return { success: true };
    }),
});
