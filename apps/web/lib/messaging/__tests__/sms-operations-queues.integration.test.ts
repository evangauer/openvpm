import { describe, expect, it } from "vitest";
import { db } from "@openpims/db/client";
import {
  loadSmsDeliveryEventQueue,
  loadSmsSendAttemptQueue,
} from "@/lib/messaging/sms-operations-queues";

const describeWithPostgres = process.env.SMS_QUEUE_DB_INTEGRATION
  ? describe
  : describe.skip;

describeWithPostgres("SMS operations queue SQL", () => {
  it("executes both read-only queue loaders against PostgreSQL", async () => {
    const now = new Date("2026-08-09T16:00:00.000Z");
    const [sendQueue, deliveryQueue] = await Promise.all([
      loadSmsSendAttemptQueue(db, {
        staleMinutes: 15,
        limit: 2,
        now,
      }),
      loadSmsDeliveryEventQueue(db, {
        staleMinutes: 60,
        limit: 2,
        now,
      }),
    ]);

    expect(sendQueue).toMatchObject({ cacheControl: "no-store", items: [] });
    expect(deliveryQueue).toMatchObject({
      cacheControl: "no-store",
      items: [],
      staleAcceptedWithoutFinalDelivery: [],
    });
  });
});
