import { describe, expect, it } from "vitest";
import { accountActivityEmail } from "../account-activity-email";
import type { PracticeTracking } from "../practice-tracking-types";

export const sample: PracticeTracking = {
  practiceId: "00000000-0000-4000-8000-000000000001",
  businessName: "Synthetic <Clinic>", ownerName: "Sample Owner", ownerEmail: "owner@example.test",
  registeredAt: "2026-11-08T09:51:00Z", emailVerifiedAt: "2026-11-08T10:55:00Z",
  billingStatus: "trialing", trialEndsAt: "2026-11-22T09:54:00Z",
  acquisition: { signupSource: "homepage_hero", medium: null, campaign: null },
  usage: { clients: 0, patients: 0, appointments: 1, soapNotes: 0, invoices: 0, files: 0, captureSessions: 1, aiRuns: 6, sms: 0 },
  lastActionAt: "2026-11-08T10:05:00Z", activeDays7: 1, activeDays30: 1,
  actions: [{ label: "Appointment created", count: 1, lastAt: "2026-11-08T09:58:00Z" }],
};
const url = "https://app.example.test/admin#practice-tracking";
describe("operator account email", () => {
  it("includes identity, verification, usage, actions, engagement and source without importing private extra fields", () => {
    const p = { ...sample, prompt: "PRIVATE_PROMPT", patientName: "PRIVATE_PATIENT" };
    const html = accountActivityEmail({ snapshotAt: "2026-11-08T17:00:00Z", practices: [p], hasMore: false }, url);
    for (const value of ["Synthetic &lt;Clinic&gt;", "Sample Owner", "owner@example.test", "Verified Nov 8", "trialing", "Nov 22", "Metered AI runs", ">6</td>", "Appointment created", "Exploring sample data", "homepage_hero", "Unknown — not captured", "exclude seeded samples", url])
      expect(html).toContain(value);
    expect(html).not.toContain("PRIVATE_PROMPT");
    expect(html).not.toContain("PRIVATE_PATIENT");
    expect(html).not.toContain("pending verification");
  });
  it("distinguishes unavailable evidence from known zero counts and bounds the report", () => {
    const unavailable = accountActivityEmail(null, url);
    expect(unavailable).toContain("unknown for this report");
    expect(unavailable).not.toContain("Exploring sample data");
    const html = accountActivityEmail({ snapshotAt: "2026-11-08T17:00:00Z", practices: Array.from({ length: 11 }, () => sample), hasMore: true }, url);
    expect(html.match(/Account-provided business name/g)).toHaveLength(10);
    expect(html).toContain(">0</td>");
    expect(html).toContain("10 newest");
  });
  it("escapes user-entered text and rejects unsafe dashboard links", () => {
    const html = accountActivityEmail({ snapshotAt: "2026-11-08T17:00:00Z", practices: [{ ...sample, businessName: '<img src=x onerror="alert(1)">' }], hasMore: false }, url);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(() => accountActivityEmail(null, "javascript:alert(1)")).toThrow("Invalid operator dashboard URL");
  });
  it("reports a registration without a subscription or recorded product actions", () => {
    const lead = { ...sample, billingStatus: "none", trialEndsAt: null, emailVerifiedAt: null,
      lastActionAt: null, activeDays7: 0, activeDays30: 0, actions: [],
      usage: { clients: 0, patients: 0, appointments: 0, soapNotes: 0, invoices: 0, files: 0, captureSessions: 0, aiRuns: 0, sms: 0 } };
    const html = accountActivityEmail({ snapshotAt: "2026-11-08T17:00:00Z", practices: [lead], hasMore: false }, url);
    expect(html).toContain("Includes signups before checkout");
    expect(html).toContain("owner@example.test");
    expect(html).toContain("Billing status:</strong> none");
    expect(html).toContain("Trial ends:</strong> Not recorded");
    expect(html).toContain("No recorded product actions");
    expect(html).not.toContain("Exploring sample data");
  });
});
