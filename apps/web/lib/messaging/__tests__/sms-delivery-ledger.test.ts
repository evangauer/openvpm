import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  projectSmsCommunicationStatus,
  redactedProviderToken,
  reduceSmsDeliveryStatus,
  SMS_DELIVERY_ACCEPTED_SWEEP_LIMIT,
  smsDeliveryFingerprint,
  type SmsDeliveryClassification,
} from "../sms-delivery-ledger";

const SOURCE = readFileSync(
  new URL("../sms-delivery-ledger.ts", import.meta.url),
  "utf8",
);
const SMS_DISPATCH_SOURCE = readFileSync(
  new URL("../../sms-dispatch.ts", import.meta.url),
  "utf8",
);

describe("SMS delivery evidence and monotone reducer", () => {
  it.each([
    ["unknown", "sent", "sent"],
    ["sent", "failed", "failed"],
    ["failed", "sent", "failed"],
    ["failed", "delivered", "delivered"],
    ["delivered", "failed", "delivered"],
    ["delivered", "sent", "delivered"],
  ] as const)("reduces %s + %s to %s", (current, observed, expected) => {
    expect(reduceSmsDeliveryStatus(current, observed)).toBe(expected);
  });

  it.each([
    [["sent", "failed", "delivered"], "delivered"],
    [["delivered", "sent", "failed"], "delivered"],
    [["failed", "sent"], "failed"],
    [["sent", "failed"], "failed"],
  ] as const)(
    "is arrival-order independent for lifecycle permutation %j",
    (events, expected) => {
      const final = events.reduce(
        (status, event) => projectSmsCommunicationStatus(status, event),
        "pending" as "pending" | "sent" | "failed" | "delivered" | "read",
      );
      expect(final).toBe(expected);
    },
  );

  it("keeps delivered/read terminal and never fabricates delivery", () => {
    expect(projectSmsCommunicationStatus("delivered", "failed")).toBe(
      "delivered",
    );
    expect(projectSmsCommunicationStatus("read", "sent")).toBe("read");
    expect(projectSmsCommunicationStatus("pending", "unknown")).toBe("pending");
  });

  it("builds a stable fingerprint only from normalized lifecycle fields", () => {
    const input = {
      provider: "twilio" as const,
      providerMessageId: "SM123",
      providerEventType: "message.status",
      providerStatus: "delivered",
      providerErrorCode: null,
      occurredAt: null,
    };
    expect(smsDeliveryFingerprint(input)).toBe(smsDeliveryFingerprint(input));
    expect(
      smsDeliveryFingerprint({ ...input, providerStatus: "failed" }),
    ).not.toBe(smsDeliveryFingerprint(input));
  });

  it("drops unbounded/arbitrary status text instead of storing payload content", () => {
    expect(redactedProviderToken(" delivery_failed ")).toBe("delivery_failed");
    expect(redactedProviderToken("Call +1 555 555 0199")).toBeNull();
    expect(redactedProviderToken("x".repeat(81))).toBe("x".repeat(80));
  });

  it("groups exact candidates before its distinct-candidate limit", () => {
    const groupAt = SOURCE.indexOf(".groupBy(");
    const limitAt = SOURCE.indexOf(".limit(100);", groupAt);
    expect(groupAt).toBeGreaterThan(0);
    expect(limitAt).toBeGreaterThan(groupAt);
  });

  it("keeps callback evidence insert-first and reprocesses exact duplicates", () => {
    const insertAt = SOURCE.indexOf(".insert(smsDeliveryEvents)");
    const processAt = SOURCE.indexOf("const result = await processEvidence");
    expect(insertAt).toBeGreaterThan(0);
    expect(processAt).toBeGreaterThan(insertAt);
    expect(SOURCE).toContain(
      "evidence.payloadFingerprintSha256 !== fingerprint",
    );
    expect(SOURCE).toContain("identity-conflict");
  });

  it("bounds callback-first reconciliation inside the accepted-send transaction", () => {
    expect(SMS_DELIVERY_ACCEPTED_SWEEP_LIMIT).toBe(100);
    expect(SOURCE).toContain(".limit(SMS_DELIVERY_ACCEPTED_SWEEP_LIMIT)");
  });

  it("timestamps append-only history after the advisory lock is acquired", () => {
    expect(SOURCE.match(/createdAt: sql`clock_timestamp\(\)`/g)).toHaveLength(
      3,
    );
    const reconciliation = SOURCE.slice(
      SOURCE.indexOf("export async function reconcileSmsDeliveryEvent"),
    );
    expect(reconciliation.indexOf("lockSmsDeliveryIdentity(")).toBeLessThan(
      reconciliation.indexOf("createdAt: sql`clock_timestamp()`"),
    );
  });

  it("takes the shared provider-message lock before callback evidence insert", () => {
    const callbackSource = SOURCE.slice(
      SOURCE.indexOf("export async function recordSmsDeliveryCallback"),
    );
    expect(callbackSource.indexOf("lockSmsDeliveryIdentity(")).toBeLessThan(
      callbackSource.indexOf(".insert(smsDeliveryEvents)"),
    );
  });

  it("takes the same lock before normal and reconciled accepted-event inserts", () => {
    const providerResult = SMS_DISPATCH_SOURCE.slice(
      SMS_DISPATCH_SOURCE.indexOf("async function appendProviderResult"),
      SMS_DISPATCH_SOURCE.indexOf("async function providerCall"),
    );
    expect(providerResult.indexOf("lockSmsDeliveryIdentity(")).toBeLessThan(
      providerResult.indexOf(".insert(smsSendAttemptEvents)"),
    );
    expect(providerResult).toContain("identityLockHeld: true");

    const reconciliation = SMS_DISPATCH_SOURCE.slice(
      SMS_DISPATCH_SOURCE.indexOf(
        "export async function reconcileSmsSendAttempt",
      ),
      SMS_DISPATCH_SOURCE.indexOf("export async function resendSmsAttempt"),
    );
    const lockAt = reconciliation.indexOf("lockSmsDeliveryIdentity(");
    const acceptedInsertAt = reconciliation.indexOf(
      ".insert(smsSendAttemptEvents)",
      lockAt,
    );
    expect(lockAt).toBeGreaterThan(0);
    expect(acceptedInsertAt).toBeGreaterThan(lockAt);
    expect(reconciliation).toContain("identityLockHeld: true");
  });

  it("defines the full reducer domain", () => {
    const domain: SmsDeliveryClassification[] = [
      "unknown",
      "sent",
      "failed",
      "delivered",
    ];
    expect(
      domain.map((value) => reduceSmsDeliveryStatus("unknown", value)),
    ).toEqual(domain);
  });
});
