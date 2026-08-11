import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "components/admin/sms-recovery-console.tsx",
  "utf8",
);
const adminPage = readFileSync("app/(dashboard)/admin/page.tsx", "utf8");
const adminRouter = readFileSync("server/routers/admin.ts", "utf8");

describe("platform-admin SMS recovery console", () => {
  it("is mounted beside SMS health and keeps all reads bounded", () => {
    expect(adminPage).toContain(
      'import { SmsRecoveryConsole } from "@/components/admin/sms-recovery-console"',
    );
    expect(adminPage).toContain("<SmsRecoveryConsole />");
    expect(source).toContain("const QUEUE_LIMIT = 25");
    expect(source).toContain("{ staleMinutes: 15, limit: QUEUE_LIMIT }");
    expect(source).toContain("{ staleMinutes: 60, limit: QUEUE_LIMIT }");
    expect(source).toContain("historyLimit: 100");
    expect(source).toContain("smsProviderEventResolutionHistory.useQuery");
    expect(source).toContain("{ limit: QUEUE_LIMIT }");
    expect(source).toContain("data.truncated");
    expect(source).toContain("candidateAttemptsTruncated");
    expect(source).toContain("!deliveryDetail.data.truncated");
  });

  it("requires exact history review and UUID idempotency for every write", () => {
    expect(source).toContain("trpc.admin.smsSendAttempt.useQuery");
    expect(source).toContain("trpc.admin.smsDeliveryEventDetail.useQuery");
    expect(source).toContain("trpc.admin.reconcileSmsSendAttempt.useMutation");
    expect(source).toContain(
      "trpc.admin.reconcileSmsDeliveryEvent.useMutation",
    );
    expect(source).toContain("window.crypto.randomUUID()");
    expect(source).toContain("attemptReviewed &&");
    expect(source).toContain("deliveryReviewed &&");
    expect(source).toContain("exactQuarantineEvidence &&");
    expect(source).toContain("window.confirm(");
    expect(source).toContain("Evidence source ${attemptEvidence}");
    expect(source).toContain("reviewedHistoryId: quarantineReason");
  });

  it("only offers resend after an exact backend-confirmed definite failure", () => {
    expect(source).toContain(
      'effectiveAttemptEvent?.outcome === "definite_failure"',
    );
    expect(source).toContain("trpc.admin.resendSmsSendAttempt.useMutation");
    expect(source).toContain("The backend ledger confirms a definite failure");
    expect(source).toContain("resendReviewed");
    expect(source).toContain("resendCompleted");
    expect(source).toMatch(/authorize\s+one new provider send/);
    expect(source).toContain("This is an external side effect.");
  });

  it("offers only evidence-valid provider incident remediation modes", () => {
    expect(source).toContain("providerEventResolutionOptions(");
    expect(source).toContain('selection.state !== "quarantined"');
    expect(source).toContain("Boolean(selection.conflictId)");
    expect(source).toContain('selection.kind === "inbound"');
    expect(source).toContain('selection.kind === "a2p"');
    expect(source).toContain("selection.practiceId &&");
    expect(source).toContain("selection.locationId &&");
    expect(source).toContain('"sender_identity_drift"');
    expect(source).toContain('"immutable_attribution_drift"');
    expect(source).toContain('value: "conservative_opt_out"');
    expect(source).toContain('value: "carrier_state_reconciled"');
    expect(source).toContain('value: "provider_attested_no_projection"');
    expect(source).toContain("conflictId: item.conflictId");
  });

  it("requires a fresh UUID, explicit attestation and confirmation", () => {
    expect(source).toContain("setProviderEventOperationId(operationId())");
    expect(source).toContain("providerEventReviewed &&");
    expect(source).toContain("providerAttestationConfirmed");
    expect(source).toContain("providerSupportReferenceInvalid");
    expect(source).toContain("Phone-like values cannot be used");
    expect(source).toContain("provider_support_invalid_callback");
    expect(source).toContain("provider_support_duplicate_callback");
    expect(source).toContain("reconcileProviderA2p.mutate");
    expect(source).toContain("resolveProviderEvent.mutate");
    expect(source).toMatch(/Apply \$\{label\(providerEventResolution\)\}/);
  });

  it("does not render phone, body, raw payload, PHI, or operator identity fields", () => {
    expect(source).not.toContain("destinationE164");
    expect(source).not.toContain("senderE164");
    expect(source).not.toContain("rawBody");
    expect(source).not.toContain("requestedByIdentity");
    expect(source).not.toContain("actorIdentity");
    expect(source).not.toContain("event.detail");
    expect(source).not.toContain("history.detail");
    expect(source).not.toContain("clientId");
    expect(source).toContain("looksLikePhoneNumber");
    expect(source).toContain("safeProviderEvidenceId");
    expect(source).toContain("WITHHELD_PHONE_LIKE_OPERATIONAL_ID");
    expect(source).toContain(
      "reviewedProviderMessageId === WITHHELD_PHONE_LIKE_OPERATIONAL_ID",
    );
    expect(source).toContain("was withheld by the server");
    expect(source).toContain("sensitive content excluded");
    expect(source).toContain("omitted at the");
    expect(source).toContain("server boundary");
    expect(source).toContain("operatorLabel");
    expect(source).not.toContain("resolvedByIdentity");
    expect(source).not.toContain("providerDetail");
  });

  it("masks carrier senders and never receives their full E.164 value", () => {
    expect(adminPage).toContain("sender.senderLast4");
    expect(adminPage).toContain("Number ••••${sender.senderLast4}");
    expect(adminPage).not.toContain("sender.senderE164");
    expect(adminRouter).toMatch(/senderLast4:\s*sql<\s*string \| null\s*>/);
    expect(adminRouter).toContain("regexp_replace");
  });

  it("keeps stale accepted sends monitor-only", () => {
    expect(source).toContain("staleAcceptedWithoutFinalDelivery");
    expect(source).toContain("remain monitor-only");
    expect(source).toMatch(
      /intentionally offers no resend or\s+status\s+override/,
    );
  });
});
