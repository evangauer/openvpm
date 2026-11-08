import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { growthLeads } from "@openpims/db";
import { withSystem } from "@/lib/tenant-db";
import { requestNewsletterSubscription, confirmNewsletterSubscription, newsletterConfirmationEligible } from "@/lib/growth/newsletter";
import { leadEmailHash } from "@/lib/growth/leads";
import { disposableClinic } from "./helpers/disposable-clinic";

const integration = process.env.NEWSLETTER_DB_INTEGRATION === "1" ? describe : describe.skip;
integration("newsletter consent persistence", () => {
  it("preserves existing consent, handles concurrent requests and confirmation retries, and respects pauses and deletion", async () => {
    const f = await disposableClinic();
    try {
      const email = "newsletter@synthetic.example";
      const buildProgress = { savedAt: "2026-11-01T00:00:00.000Z", state: { clinicName: "Synthetic clinic" } };
      await f.ownerDb.insert(growthLeads).values({ email, emailHash: leadEmailHash(email), source: "demo", disclosureVersion: "demo-v2", buildProgress });
      const now = new Date("2026-11-06T12:00:00Z");
      const request = (time = now) => withSystem(f.db, tx => requestNewsletterSubscription(tx, { email, anonymousId: null, now: time, interest: "labs", placement: "blog" }));
      const [a, b] = await Promise.all([request(), request()]);
      expect(a?.id).toBe(b?.id); expect(a?.subscription.nonce).toBe(b?.subscription.nonce);
      const row = (await f.ownerDb.select().from(growthLeads))[0]!;
      expect(row).toMatchObject({ source: "demo", disclosureVersion: "demo-v2", buildProgress });
      // Restricted application sessions cannot read lead data outside system scope.
      expect(await f.db.select().from(growthLeads)).toEqual([]);
      const newer = await request(new Date(now.getTime() + 16 * 60_000));
      expect(newer!.subscription.nonce).not.toBe(a!.subscription.nonce);
      const confirm = (nonce: string, time = now) => withSystem(f.db, tx => confirmNewsletterSubscription(tx, { leadId: row.id, nonce, now: time }));
      expect(await confirm(a!.subscription.nonce)).toBe(false);
      expect(await confirm(randomUUID())).toBe(false);
      expect(await withSystem(f.db, tx => newsletterConfirmationEligible(tx, row.id, newer!.subscription.nonce))).toBe(true);
      expect(await confirm(newer!.subscription.nonce)).toBe(true);
      expect(await confirm(newer!.subscription.nonce, new Date(now.getTime() + 3600_000))).toBe(true);
      expect((await f.ownerDb.select().from(growthLeads))[0]!.newsletterSubscription).toMatchObject({ confirmedAt: now.toISOString() });
      expect(await request()).toBeNull();
      expect(await withSystem(f.db, tx => newsletterConfirmationEligible(tx, row.id, newer!.subscription.nonce))).toBe(false);
      await f.ownerDb.update(growthLeads).set({ pausedAt: now }).where(eq(growthLeads.id, row.id));
      expect(await request()).toBeNull(); expect(await confirm(newer!.subscription.nonce)).toBe(false);
      await f.ownerDb.update(growthLeads).set({ pausedAt: null, deletedAt: now }).where(eq(growthLeads.id, row.id));
      expect(await request()).toBeNull(); expect(await confirm(newer!.subscription.nonce)).toBe(false);
    } finally { await f.close(); }
  }, 180_000);
});
