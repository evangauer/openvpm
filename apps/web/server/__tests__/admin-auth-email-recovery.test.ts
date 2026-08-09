import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/routers/admin.ts", "utf8");
const queue = source.slice(
  source.indexOf("authEmailRecoveryQueue:"),
  source.indexOf("overview:", source.indexOf("authEmailRecoveryQueue:")),
);

describe("auth verification email recovery queue", () => {
  it("surfaces missing and uncertain provider outcomes", () => {
    expect(queue).toContain("provider_outcome_missing");
    expect(queue).toContain("provider_outcome_unknown");
    expect(queue).toContain("provider_definite_failure");
    expect(queue).toContain("attempt.outcome = 'reserved'");
    expect(queue).toContain(
      "attempt.outcome in ('outcome_unknown', 'definite_failure')",
    );
    expect(queue).toContain("interval '15 minutes'");
    expect(queue).toContain("attempt.provider = 'resend'");
    expect(queue).toContain("'delivered', 'failed', 'complained'");
    expect(queue).not.toContain("'opened', 'clicked'");
  });

  it("derives out-of-order delivery matches without rewriting evidence", () => {
    expect(queue).toContain("delivery.attempt_id = attempt.id");
    expect(queue).toContain("delivery.attempt_id is null");
    expect(queue).toContain(
      "delivery.provider_message_id = attempt.provider_message_id",
    );
    expect(queue).toContain("delivery_confirmation_missing");
    expect(queue).toContain("interval '60 minutes'");
    expect(queue).toContain("identity_mismatches as");
    expect(queue).toContain("delivery.provider <> attempt.provider");
    expect(queue).toContain(
      "delivery.provider_message_id <> attempt.provider_message_id",
    );
  });

  it("keeps the operator result bounded, no-store, and recipient-free", () => {
    expect(queue).toContain("noStore()");
    expect(queue).toContain("limit ${input.limit}");
    expect(queue).toContain('cacheControl: "no-store" as const');
    expect(queue).toContain("providerMessageHint: null");
    expect(queue).not.toContain("users.email");
    expect(queue).not.toContain("recipient");
    expect(queue).not.toContain("verifyUrl");
    expect(queue).not.toContain("token");
    expect(queue).not.toContain("subject");
    expect(queue).not.toContain("body");
    expect(queue).toContain("account.email_verified_at is null");
  });
});
