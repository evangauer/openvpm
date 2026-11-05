import { and, eq, lte } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { growthLeadEmails } from "@openpims/db";
import { alertOps } from "@/lib/alerts";
import { emailPreferenceRecipientHash } from "@/lib/email-preferences";
import {
  lockAndCheckMarketingEmailEnabled,
  marketingEmailEnabledForRecipient,
} from "@/lib/platform-email-preferences";
import { withSystem } from "@/lib/tenant-db";

type SendResult = { success: boolean; id?: string; error?: string };

export const LEAD_EMAIL_PENDING_RECLAIM_MS = 30 * 60 * 1000;

export type LeadEmailOutcome = {
  sent: boolean;
  deduped: boolean;
  suppressed?: boolean;
};

/**
 * Send one optional follow-up email to a lead who has no clinic yet, at most
 * once per dedupe key. The same guarantees as practice lifecycle email: the
 * recipient's platform email preference is honored before and under the send
 * lock, eligibility is re-checked under that lock, and a failed send releases
 * its claim so the next cron run can retry. Never throws into the caller.
 */
export async function sendLeadEmail(opts: {
  leadId: string;
  to: string;
  sequence: string;
  step: number;
  dedupeKey: string;
  send: () => Promise<SendResult>;
  stillEligible?: (tx: Database) => Promise<boolean>;
}): Promise<LeadEmailOutcome> {
  try {
    if (!(await marketingEmailEnabledForRecipient(opts.to))) {
      return { sent: false, deduped: false, suppressed: true };
    }

    const claimId = await claimLeadEmail(opts);
    if (!claimId) return { sent: false, deduped: true };

    let result: SendResult;
    try {
      const delivery = await withSystem(db, async (tx) => {
        if (opts.stillEligible && !(await opts.stillEligible(tx))) {
          return { blocked: true as const };
        }
        if (!(await lockAndCheckMarketingEmailEnabled(tx, opts.to))) {
          return { blocked: true as const };
        }
        return { blocked: false as const, result: await opts.send() };
      });
      if (delivery.blocked) {
        await releaseClaim(claimId);
        return { sent: false, deduped: false, suppressed: true };
      }
      result = delivery.result;
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : "send threw",
      };
    }

    if (result.success) {
      await withSystem(db, (tx) =>
        tx
          .update(growthLeadEmails)
          .set({
            status: "sent",
            ...(result.id ? { providerMessageId: result.id } : {}),
          })
          .where(eq(growthLeadEmails.id, claimId)),
      );
      return { sent: true, deduped: false };
    }

    await alertOps(
      "Lead email failed",
      `${opts.sequence}#${opts.step} lead=${opts.leadId} recipient=${recipientReference(opts.to)}: ${result.error ?? "unknown error"}`,
    );
    await releaseClaim(claimId);
    return { sent: false, deduped: false };
  } catch (err) {
    await alertOps(
      "Lead email error",
      `${opts.sequence}#${opts.step} lead=${opts.leadId} recipient=${recipientReference(opts.to)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { sent: false, deduped: false };
  }
}

function recipientReference(email: string): string {
  return emailPreferenceRecipientHash(email)?.slice(0, 12) ?? "unavailable";
}

function releaseClaim(id: string) {
  return withSystem(db, (tx) =>
    tx.delete(growthLeadEmails).where(eq(growthLeadEmails.id, id)),
  );
}

function insertClaim(opts: {
  leadId: string;
  sequence: string;
  step: number;
  dedupeKey: string;
}) {
  return withSystem(db, (tx) =>
    tx
      .insert(growthLeadEmails)
      .values({
        leadId: opts.leadId,
        sequence: opts.sequence,
        step: opts.step,
        dedupeKey: opts.dedupeKey,
        status: "pending",
      })
      .onConflictDoNothing({ target: growthLeadEmails.dedupeKey })
      .returning({ id: growthLeadEmails.id }),
  );
}

/**
 * Claim the dedupe key. A fresh pending row means another worker is sending;
 * an old one means a worker died mid-send, so it may be reclaimed.
 */
async function claimLeadEmail(opts: {
  leadId: string;
  sequence: string;
  step: number;
  dedupeKey: string;
}): Promise<string | null> {
  const claimed = (await insertClaim(opts))[0];
  if (claimed) return claimed.id;

  const staleBefore = new Date(Date.now() - LEAD_EMAIL_PENDING_RECLAIM_MS);
  const deleted = await withSystem(db, (tx) =>
    tx
      .delete(growthLeadEmails)
      .where(
        and(
          eq(growthLeadEmails.dedupeKey, opts.dedupeKey),
          eq(growthLeadEmails.status, "pending"),
          lte(growthLeadEmails.createdAt, staleBefore),
        ),
      )
      .returning({ id: growthLeadEmails.id }),
  );
  if (!deleted[0]) return null;
  return (await insertClaim(opts))[0]?.id ?? null;
}
