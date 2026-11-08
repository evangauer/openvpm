import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ db: {}, billing: vi.fn(() => true), rate: vi.fn(async () => ({ success: true })), request: vi.fn(), send: vi.fn(async () => ({ sent: true, deduped: false })), confirm: vi.fn(async () => true) }));
vi.mock("@openpims/db/client", () => ({ db: mocks.db }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: (_: unknown, fn: (tx: unknown) => unknown) => fn(mocks.db) }));
vi.mock("@/lib/billing/plans", () => ({ billingEnforced: mocks.billing }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate }));
vi.mock("@/lib/email", () => ({ sendNewsletterEmail: vi.fn() }));
vi.mock("@/lib/growth/lead-email", () => ({ sendLeadEmail: mocks.send }));
vi.mock("@/lib/growth/newsletter", async importOriginal => ({ ...await importOriginal<object>(), requestNewsletterSubscription: mocks.request, confirmNewsletterSubscription: mocks.confirm }));
const { POST } = await import("./route");
const { POST: CONFIRM } = await import("./confirm/route");
const { createNewsletterToken } = await import("@/lib/growth/newsletter");
const now = new Date();
const subscription = { disclosureVersion: "newsletter-confirmed-v1", nonce: "00000000-0000-4000-8000-000000000001", requestedAt: now.toISOString(), confirmedAt: null, interest: "general", placement: "site" } as const;
const input = { email: "reader@example.test", consent: true, disclosureVersion: subscription.disclosureVersion };
const req = (body: unknown, origin = "https://openvpm.com") => new Request("https://app.openvpm.com/api/growth/newsletter", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubEnv("NEWSLETTER_SIGNUP_ENABLED", "true");
  vi.stubEnv("EMAIL_PREFERENCE_SIGNING_SECRET", "newsletter-test-secret-with-over-32-characters");
  mocks.billing.mockReturnValue(true); mocks.rate.mockResolvedValue({ success: true });
  mocks.request.mockResolvedValue({ id: subscription.nonce, subscription });
  mocks.send.mockResolvedValue({ sent: true, deduped: false });
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("requires enablement, known origin, explicit consent and a bounded request", async () => {
  vi.stubEnv("NEWSLETTER_SIGNUP_ENABLED", ""); expect((await POST(req(input))).status).toBe(404);
  vi.stubEnv("NEWSLETTER_SIGNUP_ENABLED", "true");
  expect((await POST(req(input, "https://evil.test"))).status).toBe(403);
  expect((await POST(req({ email: input.email }))).status).toBe(400);
  expect((await POST(req({ ...input, extra: "x".repeat(2100) }))).status).toBe(413);
  expect(mocks.request).not.toHaveBeenCalled();
});
it("returns the same accepted response for new, existing and suppressed subscribers", async () => {
  expect((await POST(req(input))).status).toBe(202);
  mocks.request.mockResolvedValue(null); expect((await POST(req(input))).status).toBe(202);
  mocks.request.mockResolvedValue({ id: subscription.nonce, subscription });
  mocks.send.mockResolvedValue({ sent: false, deduped: true }); expect((await POST(req(input))).status).toBe(202);
  expect(mocks.request).toHaveBeenCalledWith(mocks.db, expect.objectContaining({ interest: "general", placement: "site" }));
});
it("fails closed on signing, rate limiting and delivery failure", async () => {
  vi.stubEnv("EMAIL_PREFERENCE_SIGNING_SECRET", ""); expect((await POST(req(input))).status).toBe(503); expect(mocks.request).not.toHaveBeenCalled();
  vi.stubEnv("EMAIL_PREFERENCE_SIGNING_SECRET", "newsletter-test-secret-with-over-32-characters");
  mocks.rate.mockResolvedValue({ success: false }); expect((await POST(req(input))).status).toBe(429);
  mocks.rate.mockResolvedValue({ success: true }); mocks.send.mockResolvedValue({ sent: false, deduped: false });
  expect((await POST(req(input))).status).toBe(503);
});
it("confirms only valid signed tokens, with explicit same-origin POST, after signup is paused", async () => {
  vi.stubEnv("NEWSLETTER_SIGNUP_ENABLED", "");
  const token = createNewsletterToken(subscription.nonce, subscription)!;
  expect((await CONFIRM(req({ token }, "https://evil.test"))).status).toBe(403);
  expect((await CONFIRM(req({ token: token + "x" }, "https://app.openvpm.com"))).status).toBe(400);
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect((await CONFIRM(req({ token }, "https://app.openvpm.com"))).status).toBe(200);
});
