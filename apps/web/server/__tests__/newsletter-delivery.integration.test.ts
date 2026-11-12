import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@openpims/db/client";
import { growthLeads, growthLeadEmails, practices, users } from "@openpims/db";
import { leadEmailHash } from "@/lib/growth/leads";
import { withSystem } from "@/lib/tenant-db";
import { disposableClinic } from "./helpers/disposable-clinic";
const mocks = vi.hoisted(() => ({ db: null as Database | null, send: vi.fn(async (_input: unknown) => ({ success: true, id: "synthetic-provider-id" })) }));
vi.mock("@openpims/db/client", () => ({ get db() { return mocks.db; } }));
vi.mock("@/lib/email", () => ({ sendNewsletterEmail: mocks.send }));
vi.mock("@/lib/alerts", () => ({ alertOps: vi.fn() }));
vi.mock("@/lib/cron-heartbeat", () => ({ reportCronHeartbeat: vi.fn() }));
const integration = process.env.NEWSLETTER_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("newsletter delivery through the real lead queue", () => {
  it("deduplicates requests and cron sends, honors unsubscribe, paces steps, and stops after account creation", async () => {
    const f = await disposableClinic(); mocks.db = f.db;
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true"); vi.stubEnv("NEWSLETTER_SIGNUP_ENABLED", "true");
    vi.stubEnv("NEWSLETTER_FOLLOWUP_ENABLED", "true"); vi.stubEnv("NEWSLETTER_FOLLOWUP_ROLLOUT_AT", "2026-01-01T00:00:00Z");
    vi.stubEnv("EMAIL_PREFERENCE_SIGNING_SECRET", randomUUID() + randomUUID());
    vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET", randomUUID() + randomUUID());
    vi.stubEnv("EMAIL_PREFERENCE_IDENTITY_SECRET_PREVIOUS", "");
    vi.stubEnv("CRON_SECRET", randomUUID());
    try {
      const { POST } = await import("@/app/api/growth/newsletter/route");
      const { POST: CONFIRM } = await import("@/app/api/growth/newsletter/confirm/route");
      const { GET } = await import("@/app/api/cron/newsletter-followup/route");
      const { setMarketingEmailPreferenceForRecipient } = await import("@/lib/platform-email-preferences");
      const email = "delivery@synthetic.example";
      const request = (address = email) => POST(new Request("https://app.openvpm.com/api/growth/newsletter", { method: "POST", headers: { origin: "https://openvpm.com", "Content-Type": "application/json" }, body: JSON.stringify({ email: address, consent: true, disclosureVersion: "newsletter-confirmed-v1", interest: "labs", placement: "updates" }) }));
      const cron = () => GET(new Request("https://app.openvpm.com/api/cron/newsletter-followup", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }));
      expect((await GET(new Request("https://app.openvpm.com/api/cron/newsletter-followup"))).status).toBe(401);
      expect((await request()).status).toBe(202); expect((await request()).status).toBe(202);
      expect(mocks.send).toHaveBeenCalledTimes(1);
      const token = (mocks.send.mock.calls[0]![0] as { token: string }).token;
      expect(await (await cron()).json()).toMatchObject({ sent: 0 });
      const response = await CONFIRM(new Request("https://app.openvpm.com/api/growth/newsletter/confirm", { method: "POST", headers: { origin: "https://app.openvpm.com", "Content-Type": "application/json" }, body: JSON.stringify({ token }) }));
      expect(response.status).toBe(200);
      const parallel = await Promise.all([cron(), cron()]);
      expect((await Promise.all(parallel.map(r => r.json()))).reduce((n, r) => n + r.sent, 0)).toBe(1);
      expect(mocks.send.mock.calls.map(c => (c[0] as { step: number }).step)).toEqual([0, 1]);
      expect(await (await cron()).json()).toMatchObject({ sent: 0 });
      const lead = (await f.ownerDb.select().from(growthLeads).where(eq(growthLeads.email, email)))[0]!;
      // Simulate elapsed time in the disposable database, without waiting days.
      const confirmedAt = new Date(Date.now() - 8 * 86400_000).toISOString();
      await f.ownerDb.execute(sql`update growth_leads set newsletter_subscription = jsonb_set(newsletter_subscription, '{confirmedAt}', to_jsonb(${confirmedAt}::text)) where id = ${lead.id}::uuid`);
      await f.ownerDb.update(growthLeadEmails).set({ createdAt: new Date(Date.now() - 25 * 3600_000) });
      expect(await (await cron()).json()).toMatchObject({ sent: 1 });
      expect((mocks.send.mock.calls.at(-1)![0] as { step: number }).step).toBe(2);
      expect(await (await cron()).json()).toMatchObject({ sent: 0 });
      const [practice] = await f.ownerDb.insert(practices).values({ name: "Synthetic signup" }).returning();
      await f.ownerDb.insert(users).values({ practiceId: practice!.id, email, name: "Synthetic subscriber", role: "admin", passwordHash: "not-a-password" });
      await f.ownerDb.update(growthLeadEmails).set({ createdAt: new Date(Date.now() - 25 * 3600_000) });
      expect(await (await cron()).json()).toMatchObject({ sent: 0 });
      // A previous unsubscribe cannot be reset by a new public subscription request.
      const optedOut = "opted-out@synthetic.example";
      await setMarketingEmailPreferenceForRecipient({ email: optedOut, enabled: false, source: "unsubscribe_link" });
      const count = mocks.send.mock.calls.length;
      expect((await request(optedOut)).status).toBe(202); expect(mocks.send).toHaveBeenCalledTimes(count);
      // Suppressing a confirmed subscriber retires their introduction from the queue.
      await f.ownerDb.delete(users).where(eq(users.email, email));
      await setMarketingEmailPreferenceForRecipient({ email, enabled: false, source: "unsubscribe_link" });
      expect(await (await cron()).json()).toMatchObject({ suppressed: 1, sent: 0 });
      expect(await (await cron()).json()).toMatchObject({ candidates: 0 });
      expect(mocks.send).toHaveBeenCalledTimes(count);
      expect((await withSystem(f.db, tx => tx.select().from(growthLeadEmails))).filter(e => e.sequence === "newsletter-welcome")).toHaveLength(2);
      const finalEmail = "final-note@synthetic.example";
      const [finalLead] = await f.ownerDb.insert(growthLeads).values({ email: finalEmail, emailHash: leadEmailHash(finalEmail), source: "newsletter", disclosureVersion: "newsletter-confirmed-v1", newsletterSubscription: {
        disclosureVersion: "newsletter-confirmed-v1", nonce: randomUUID(), requestedAt: confirmedAt, confirmedAt, interest: "offline", placement: "updates",
      } }).returning();
      await f.ownerDb.insert(growthLeadEmails).values([1, 2].map(step => ({ leadId: finalLead!.id, sequence: "newsletter-welcome", step, status: "sent", dedupeKey: `lead:newsletter-welcome:${finalLead!.id}:${step}`, createdAt: new Date(Date.now() - 25 * 3600_000) })));
      expect(await (await cron()).json()).toMatchObject({ sent: 1 });
      expect(mocks.send.mock.calls.at(-1)![0]).toMatchObject({ step: 3, interest: "offline" });
      expect(await (await cron()).json()).toMatchObject({ candidates: 0, sent: 0 });
    } finally { vi.unstubAllEnvs(); await f.close(); mocks.db = null; }
  }, 180_000);
});
