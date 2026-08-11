import { createHmac } from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { webhooks } from "@openpims/db";
import { alertOps } from "@/lib/alerts";
import { withSystem } from "@/lib/tenant-db";
import { isWebhookDeliveryUrl } from "@/lib/webhook-urls";
import { lockPracticeForExternalSideEffects } from "@/lib/recovery-hold";

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

export async function dispatchWebhookEvent(
  practiceId: string,
  event: string,
  payload: Record<string, any>,
): Promise<void> {
  try {
    await withSystem(db, async (tx) => {
      // Keep this shared practice-row lock through the full delivery batch.
      // Recovery's hold update therefore drains already-started deliveries
      // before it commits and blocks every new delivery after it commits.
      if (
        !(await lockPracticeForExternalSideEffects(
          tx as unknown as Database,
          practiceId,
        ))
      ) {
        return;
      }

      const activeWebhooks = await tx
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.practiceId, practiceId),
            eq(webhooks.active, true),
            isNull(webhooks.deletedAt),
          ),
        );

      // Filter to webhooks that subscribe to this event
      const matching = activeWebhooks.filter((wh) => {
        const events = wh.events as string[];
        return (
          Array.isArray(events) &&
          (events.includes("*") || events.includes(event))
        );
      });

      if (matching.length === 0) return;

      const body = JSON.stringify({
        event,
        timestamp: new Date().toISOString(),
        data: payload,
      });

      const requests = matching.map(async (wh) => {
        try {
          if (!isWebhookDeliveryUrl(wh.url)) {
            throw new Error("Invalid webhook delivery URL");
          }

          const signature = createHmac("sha256", wh.secret)
            .update(body)
            .digest("hex");

          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            WEBHOOK_DELIVERY_TIMEOUT_MS,
          );
          try {
            const res = await fetch(wh.url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Webhook-Event": event,
                "X-Webhook-Signature": signature,
              },
              body,
              signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          } finally {
            clearTimeout(timeout);
          }
          return true;
        } catch (err) {
          console.error(
            `[WebhookDispatcher] Failed to deliver ${event} to ${wh.url}:`,
            err,
          );
          return false;
        }
      });

      // Deliver in parallel, but let the returned promise represent the
      // delivery batch and the recovery serialization lock.
      const results = await Promise.allSettled(requests);
      const failed = results.filter(
        (r) => r.status === "rejected" || r.value === false,
      ).length;
      if (failed > 0) {
        await alertOps(
          "Webhook delivery failed",
          `${failed} of ${matching.length} '${event}' webhook deliveries failed for practice ${practiceId}.`,
        );
      }
    });
  } catch (err) {
    console.error("[WebhookDispatcher] Failed to query webhooks:", err);
    await alertOps(
      "Webhook dispatch query failed",
      `Could not load webhook subscriptions for practice ${practiceId} while dispatching '${event}'.`,
    );
  }
}
