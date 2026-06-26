import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, requireRole } from "../trpc";
import {
  locations,
  locationMessaging,
  clients,
  smsSuppressions,
  practices,
} from "@openpims/db";
import { usageForPractice, currentPeriodMonth } from "@/lib/billing/usage";
import { getPlan } from "@/lib/billing/plans";
import { normalizeE164 } from "@/lib/messaging";
import { sendSms } from "@/lib/sms";
import {
  searchAvailableNumbers,
  checkHostedEligibility,
  createMessagingProfile,
  buyNumber,
  createHostedOrder,
  TelnyxNotConfiguredError,
} from "@/lib/messaging/telnyx-provisioning";

const adminOnly = protectedProcedure.use(requireRole("admin"));

/** Map a thrown provisioning error to a tRPC error the UI can show. */
function provisioningError(e: unknown): TRPCError {
  if (e instanceof TelnyxNotConfiguredError) {
    return new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
  }
  return new TRPCError({
    code: "BAD_GATEWAY",
    message: e instanceof Error ? e.message : "Messaging provider request failed",
  });
}

export const messagingRouter = createRouter({
  /**
   * Per-location messaging status + this month's SMS usage + consent stats.
   * Drives the Settings → Messaging tab.
   */
  getStatus: adminOnly.query(async ({ ctx }) => {
    const locs = await ctx.db
      .select({
        locationId: locations.id,
        name: locations.name,
        isPrimary: locations.isPrimary,
        existingPhone: locations.phone,
        provider: locationMessaging.provider,
        senderE164: locationMessaging.senderE164,
        numberSource: locationMessaging.numberSource,
        registrationStatus: locationMessaging.registrationStatus,
        registrationDetail: locationMessaging.registrationDetail,
        enabled: locationMessaging.enabled,
      })
      .from(locations)
      .leftJoin(
        locationMessaging,
        eq(locationMessaging.locationId, locations.id)
      )
      .where(
        and(eq(locations.practiceId, ctx.practiceId), isNull(locations.deletedAt))
      );

    const period = currentPeriodMonth();
    const smsUsed = await usageForPractice(ctx.practiceId, "sms", period);

    const [practice] = await ctx.db
      .select({ tier: practices.subscriptionTier })
      .from(practices)
      .where(eq(practices.id, ctx.practiceId))
      .limit(1);
    const includedSms = getPlan(practice?.tier ?? "free")?.includedSmsPerMonth ?? null;

    const [consentRow] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(clients)
      .where(
        and(
          eq(clients.practiceId, ctx.practiceId),
          eq(clients.smsConsent, true),
          isNull(clients.deletedAt)
        )
      );
    const [suppressedRow] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(smsSuppressions)
      .where(eq(smsSuppressions.practiceId, ctx.practiceId));

    return {
      locations: locs.map((l) => ({
        locationId: l.locationId,
        name: l.name,
        isPrimary: l.isPrimary,
        existingPhone: l.existingPhone,
        messaging: l.provider
          ? {
              provider: l.provider,
              senderE164: l.senderE164,
              numberSource: l.numberSource,
              registrationStatus: l.registrationStatus,
              registrationDetail: l.registrationDetail,
              enabled: l.enabled,
            }
          : null,
      })),
      usage: { period, smsUsed, includedSms },
      consent: {
        optedIn: consentRow?.n ?? 0,
        suppressed: suppressedRow?.n ?? 0,
      },
    };
  }),

  /** Search purchasable local SMS numbers, optionally by US area code. */
  searchNumbers: adminOnly
    .input(
      z.object({
        areaCode: z
          .string()
          .regex(/^\d{3}$/, "Area code must be 3 digits")
          .optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
    )
    .query(async ({ input }) => {
      try {
        return await searchAvailableNumbers(input);
      } catch (e) {
        throw provisioningError(e);
      }
    }),

  /** Can this location's existing number be text-enabled (hosted SMS, no port)? */
  checkEligibility: adminOnly
    .input(z.object({ locationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [loc] = await ctx.db
        .select({ phone: locations.phone })
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.practiceId, ctx.practiceId)
          )
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }
      const e164 = normalizeE164(loc.phone);
      if (!e164) {
        return {
          eligible: false,
          detail:
            "Add a valid phone number to this location before checking eligibility.",
        };
      }
      try {
        return await checkHostedEligibility(e164);
      } catch (e) {
        throw provisioningError(e);
      }
    }),

  /**
   * Stand up a texting number for a location: create a messaging profile (with
   * our inbound webhook), then either text-enable the location's existing number
   * (host) or buy a new local number, and save the config. Leaves the location
   * disabled + registration pending (carrier A2P approval precedes sending).
   */
  provisionNumber: adminOnly
    .input(
      z.object({
        locationId: z.string().uuid(),
        mode: z.enum(["host", "buy"]),
        // Required for "buy"; for "host" we use the location's existing number.
        phoneNumber: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [loc] = await ctx.db
        .select({ id: locations.id, name: locations.name, phone: locations.phone })
        .from(locations)
        .where(
          and(
            eq(locations.id, input.locationId),
            eq(locations.practiceId, ctx.practiceId)
          )
        )
        .limit(1);
      if (!loc) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Location not found" });
      }

      const e164 = normalizeE164(
        input.mode === "host" ? loc.phone : input.phoneNumber
      );
      if (!e164) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            input.mode === "host"
              ? "Add a valid phone number to this location before text-enabling it."
              : "Select a valid number to purchase.",
        });
      }

      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const webhookUrl = `${appUrl}/api/webhooks/telnyx`;

      try {
        const profile = await createMessagingProfile({
          name: `${loc.name} — OpenVPM`,
          webhookUrl,
        });
        const numberSource = input.mode === "host" ? "hosted" : "purchased";
        if (input.mode === "host") {
          await createHostedOrder({ phoneNumber: e164, messagingProfileId: profile.id });
        } else {
          await buyNumber({ phoneNumber: e164, messagingProfileId: profile.id });
        }

        await ctx.db
          .insert(locationMessaging)
          .values({
            practiceId: ctx.practiceId,
            locationId: loc.id,
            provider: "telnyx",
            messagingProfileId: profile.id,
            senderE164: e164,
            numberSource,
            registrationStatus: "pending",
            registrationDetail:
              "Carrier registration (A2P 10DLC) in progress — required before messages can send; typically 1–2 weeks.",
            enabled: false,
          })
          .onConflictDoUpdate({
            target: locationMessaging.locationId,
            set: {
              provider: "telnyx",
              messagingProfileId: profile.id,
              senderE164: e164,
              numberSource,
              registrationStatus: "pending",
              updatedAt: new Date(),
            },
          });

        return { ok: true, senderE164: e164, numberSource };
      } catch (e) {
        throw provisioningError(e);
      }
    }),

  /** Turn sending on/off for a location (independent of registration state). */
  setEnabled: adminOnly
    .input(z.object({ locationId: z.string().uuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(locationMessaging)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(
          and(
            eq(locationMessaging.locationId, input.locationId),
            eq(locationMessaging.practiceId, ctx.practiceId)
          )
        )
        .returning();
      if (!updated) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Set up a number for this location first.",
        });
      }
      return { ok: true, enabled: updated.enabled };
    }),

  /** Send a test SMS to a staff number from the location's sender. */
  testSend: adminOnly
    .input(z.object({ locationId: z.string().uuid(), to: z.string().min(7) }))
    .mutation(async ({ ctx, input }) => {
      const result = await sendSms({
        to: input.to,
        body: "OpenVPM test message — your texting is set up correctly.",
        practiceId: ctx.practiceId,
        locationId: input.locationId,
      });
      if (!result.success) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.error ?? "Test send failed.",
        });
      }
      return { ok: true, id: result.sid };
    }),
});
