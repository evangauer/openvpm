import { afterEach, describe, expect, it, vi } from "vitest";
import { createFeedbackToken } from "../feedback-token";
import { createNewsletterToken, verifyNewsletterToken, newsletterStepDue, newsletterFollowupConfig, newsletterSignupEnabled, parseNewsletterSubscription, NEWSLETTER_DISCLOSURE } from "../newsletter";
import { newsletterOptions, newsletterOriginAllowed } from "../newsletter-http";
import { renderNewsletterEmail, openvpmBrand } from "@openpims/email";
const secret = "newsletter-test-signing-secret-with-more-than-32-bytes";
const leadId = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-11-06T12:00:00Z");
const subscription = { disclosureVersion: NEWSLETTER_DISCLOSURE, nonce: leadId, requestedAt: now.toISOString(), confirmedAt: null, interest: "labs", placement: "blog" } as const;
afterEach(() => vi.unstubAllEnvs());
describe("newsletter consent and pacing", () => {
  it("uses a stable, purpose-bound, expiring confirmation token without an address", () => {
    const token = createNewsletterToken(leadId, subscription, { secret })!;
    expect(createNewsletterToken(leadId, subscription, { secret })).toBe(token);
    expect(verifyNewsletterToken(token, { now, secret })).toEqual({ leadId, nonce: leadId });
    expect(verifyNewsletterToken(token, { now: new Date(now.getTime() + 48 * 3600_000), secret })).toBeNull();
    expect(verifyNewsletterToken(token + "x", { now, secret })).toBeNull();
    const other = createFeedbackToken("openvpm.other.v1", { practiceId: leadId, survey: leadId, ttlSeconds: 100 }, { now, secret });
    expect(verifyNewsletterToken(other, { now, secret })).toBeNull();
    expect(Buffer.from(token.split(".")[0]!, "base64url").toString()).not.toContain("email");
  });
  it("requires explicit enablement and a valid prospective rollout", () => {
    vi.stubEnv("NEWSLETTER_SIGNUP_ENABLED", ""); vi.stubEnv("NEWSLETTER_FOLLOWUP_ENABLED", "");
    expect(newsletterSignupEnabled()).toBe(false); expect(newsletterFollowupConfig()).toBeNull();
    vi.stubEnv("NEWSLETTER_FOLLOWUP_ENABLED", "true"); vi.stubEnv("NEWSLETTER_FOLLOWUP_ROLLOUT_AT", "invalid");
    expect(newsletterFollowupConfig()).toBeNull();
    vi.stubEnv("NEWSLETTER_FOLLOWUP_ROLLOUT_AT", now.toISOString()); expect(newsletterFollowupConfig()?.rolloutAt).toEqual(now);
  });
  it("paces three messages, never catches up in a burst, and expires old sequences", () => {
    const due = (hours: number, sentSteps: number[], lastEmailAt: string | null = null) => newsletterStepDue({ now: new Date(now.getTime() + hours * 3600_000), confirmedAt: now.toISOString(), sentSteps, lastEmailAt });
    expect(due(0, [])).toBe(1); expect(due(47, [1])).toBeNull(); expect(due(48, [1])).toBe(2);
    expect(due(168, [1, 2])).toBe(3); expect(due(240, [1, 2, 3])).toBeNull(); expect(due(721, [])).toBeNull();
    expect(due(168, [])).toBe(1); expect(due(168, [1], new Date(now.getTime() + 167 * 3600_000).toISOString())).toBeNull();
    expect(due(48, [1], "invalid")).toBeNull(); expect(due(-1, [])).toBeNull();
    expect(parseNewsletterSubscription({ ...subscription, confirmedAt: "garbage" })).toBeNull();
  });
  it("allows the website preflight but rejects an unrelated origin", () => {
    const req = (origin: string) => new Request("https://app.openvpm.com/api/growth/newsletter", { method: "OPTIONS", headers: { origin } });
    expect(newsletterOptions(req("https://openvpm.com")).headers.get("Access-Control-Allow-Origin")).toBe("https://openvpm.com");
    expect(newsletterOriginAllowed(req("https://openvpm.com.evil.test"))).toBe(false);
    expect(newsletterOptions(req("https://evil.test")).status).toBe(403);
  });
  it("renders confirmation and honest interest-specific notes with an unsubscribe link", async () => {
    for (const step of [0, 1, 2, 3] as const) {
      const result = await renderNewsletterEmail({ brand: openvpmBrand(), step, interest: "labs", senderName: null, actionUrl: "https://app.openvpm.com/clinic-fit", unsubscribeUrl: "https://app.openvpm.com/email-preferences" });
      expect(result.html).toContain("email-preferences");
      expect(result.subject).toBeTruthy();
      if (step === 0) expect(result.html).toContain("48 hours");
      if (step === 2) expect(result.html).toContain("Direct lab-provider integrations are not available yet");
    }
  });
});
