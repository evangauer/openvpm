import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@openpims/db/client", () => ({ db: {}, Database: {} }));
vi.mock("@/lib/alerts", () => ({ alertOps: vi.fn() }));
vi.mock("@/lib/tenant-db", () => ({ withSystem: vi.fn() }));
vi.mock("@/lib/email", () => ({
  dispatchPreparedEmailWithProviderEvidence: vi.fn(),
  emailProviderForDispatch: vi.fn(() => "resend"),
  prepareSubscriptionCanceledEmail: vi.fn(),
  prepareSubscriptionConfirmedEmail: vi.fn(),
}));

const SOURCE = readFileSync(new URL("./lifecycle-email-outbox.ts", import.meta.url), "utf8");
const SCHEMA_SOURCE = readFileSync(
  new URL("../../../../packages/db/schema/lifecycle-email-jobs.ts", import.meta.url),
  "utf8",
);

let helpers: typeof import("./lifecycle-email-outbox");

beforeAll(async () => {
  vi.stubEnv(
    "EMAIL_PREFERENCE_IDENTITY_SECRET",
    "lifecycle-test-identity-secret-at-least-32-bytes",
  );
  helpers = await import("./lifecycle-email-outbox");
});

afterAll(() => vi.unstubAllEnvs());

describe("subscription lifecycle email outbox safety model", () => {
  it("binds recipient identity without persisting the address or rendered body", () => {
    const a = helpers.recipientHash(
      "00000000-0000-0000-0000-000000000001",
      " Owner@Example.COM ",
    );
    const b = helpers.recipientHash(
      "00000000-0000-0000-0000-000000000001",
      "owner@example.com",
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(SOURCE).toContain("emailPreferenceRecipientHash");
    expect(SCHEMA_SOURCE).not.toMatch(/recipientEmail|renderedHtml|emailBody/);
  });

  it("fingerprints the exact stable provider request", () => {
    const request = {
      to: "Owner@Example.com",
      from: "OpenVPM <noreply@mail.openvpm.com>",
      replyTo: "support@openvpm.com",
      subject: "Subscription confirmed",
      html: "<p>Ready</p>",
      idempotencyKey: "lc:confirmed:sub_123",
      tags: [{ name: "openvpm_email_kind", value: "subscription_confirmed" }],
    };
    expect(helpers.requestFingerprint(request)).toBe(
      helpers.requestFingerprint({ ...request, to: "owner@example.COM" }),
    );
    expect(helpers.requestFingerprint(request)).not.toBe(
      helpers.requestFingerprint({ ...request, html: "<p>Changed</p>" }),
    );
  });

  it("retries definite failures with backoff and terminates after the bound", () => {
    const now = new Date("2026-08-25T12:00:00Z");
    expect(
      helpers.lifecycleEmailFailureAction({
        outcome: "definite_failure",
        attemptNumber: 1,
        firstAttemptAt: now,
        now,
      }),
    ).toBe("retry");
    expect(helpers.retryDelayMs(1)).toBe(60_000);
    expect(helpers.retryDelayMs(4)).toBe(60 * 60_000);
    expect(
      helpers.lifecycleEmailFailureAction({
        outcome: "definite_failure",
        attemptNumber: 5,
        firstAttemptAt: now,
        now,
      }),
    ).toBe("failed");
  });

  it("retries unknown outcomes only inside the provider idempotency window", () => {
    const firstAttemptAt = new Date("2026-08-25T00:00:00Z");
    expect(
      helpers.lifecycleEmailFailureAction({
        outcome: "outcome_unknown",
        attemptNumber: 2,
        firstAttemptAt,
        now: new Date("2026-08-25T22:59:59Z"),
      }),
    ).toBe("retry");
    expect(
      helpers.lifecycleEmailFailureAction({
        outcome: "outcome_unknown",
        attemptNumber: 3,
        firstAttemptAt,
        now: new Date("2026-08-25T23:00:00Z"),
      }),
    ).toBe("outcome_unknown");
  });

  it("reserves durable attempt evidence before the provider call and reclaims crash leases", () => {
    expect(SOURCE).toContain('eq(lifecycleEmailJobs.state, "delivering")');
    expect(SOURCE).toContain("lte(lifecycleEmailJobs.leaseExpiresAt, now)");
    expect(SOURCE).toContain("tx.insert(lifecycleEmailAttempts)");
    expect(SOURCE).toContain("isNull(lifecycleEmailAttempts.resolvedAt)");
    expect(SOURCE).toContain('"idempotency_window_expired"');
    expect(SOURCE).toContain('"provider_changed_after_unknown"');
    expect(SOURCE.indexOf("reserveAttempt(claimed")).toBeLessThan(
      SOURCE.indexOf("dispatchPreparedEmailWithProviderEvidence(prepared)"),
    );
    expect(SOURCE).toContain("idempotencyKey: job.providerIdempotencyKey");
  });

  it("holds the practice eligibility fence across the bounded provider call", () => {
    const fence = SOURCE.slice(
      SOURCE.indexOf("async function dispatchWithEligibilityFence"),
      SOURCE.indexOf("async function resolveReservedWithoutDispatch"),
    );
    expect(fence).toContain('.for("update")');
    expect(fence).toContain("practice?.recoveryHold");
    expect(fence).toContain("practice.subscriptionGeneration");
    expect(fence.indexOf('.for("update")')).toBeLessThan(
      fence.indexOf("dispatchPreparedEmailWithProviderEvidence(prepared)"),
    );
  });

  it("uses skip-locked claiming plus lease-token CAS for concurrency", () => {
    expect(SOURCE).toContain('.for("update", { skipLocked: true })');
    expect(SOURCE).toContain("eq(lifecycleEmailJobs.leaseToken, claimed.leaseToken)");
  });

  it("contains per-job failures, preserves ambiguous evidence, and continues", () => {
    const batch = SOURCE.slice(
      SOURCE.indexOf("export async function runLifecycleEmailBatch"),
      SOURCE.indexOf("async function claimNextJob"),
    );
    const recovery = SOURCE.slice(
      SOURCE.indexOf("async function recoverClaimedJobAfterError"),
      SOURCE.indexOf("async function claimNextJob"),
    );
    expect(batch).toContain("recoverClaimedJobAfterError");
    expect(batch).toContain("metrics.errors++");
    expect(recovery).toContain("worker_error_after_reservation");
    expect(recovery).toContain("worker_error_before_reservation");
    expect(recovery).toContain('state: ambiguous ? "retry" : "pending"');
  });

  it("revalidates recovery, contact, generation, and cancellation identity", () => {
    expect(SOURCE).toContain("practice?.recoveryHold");
    expect(SOURCE).toContain("recipientHash(job.practiceId, recipient)");
    expect(SOURCE).toContain(
      "preparedRecipientHash === job.recipientHashSha256",
    );
    expect(SOURCE).toContain(
      "practice.subscriptionGeneration === job.subscriptionGeneration",
    );
    expect(SOURCE).toContain('practice.billingStatus === "canceled"');
    expect(SOURCE).toContain("practice.stripeSubscriptionId === null");
    expect(SOURCE).toContain('state: "suppressed_stale"');
  });

  it("closes the generic communication ledger for terminal unknown outcomes", () => {
    const terminalUnknown = SOURCE.slice(
      SOURCE.indexOf("async function completeUnknown"),
    );
    expect(terminalUnknown).toContain('.set({ status: "failed" })');
    expect(terminalUnknown).toContain("communicationId");
  });
});
