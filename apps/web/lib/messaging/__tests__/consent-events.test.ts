import { describe, expect, it, vi } from "vitest";
import {
  appendRequiredSmsConsentEventInTransaction,
  appendSmsConsentEventInTransaction,
  inboundSmsConsentEventKey,
  SMS_CONSENT_EVENT_DETAIL_MAX_LENGTH,
} from "../consent-events";

describe("SMS consent event evidence", () => {
  it("uses deterministic bounded keys for provider webhook replay", () => {
    expect(inboundSmsConsentEventKey("telnyx", "message-1", "revoked")).toBe(
      "inbound:telnyx:message-1:revoked",
    );

    const longId = `message-${"x".repeat(240)}`;
    const first = inboundSmsConsentEventKey("twilio", longId, "granted");
    const second = inboundSmsConsentEventKey("twilio", longId, "granted");
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(200);
  });

  it("returns false when an exact event was already appended", async () => {
    const returning = vi.fn(async () => []);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));

    await expect(
      appendSmsConsentEventInTransaction({ insert } as never, {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        destinationE164: "+15555550123",
        action: "revoked",
        source: "inbound_opt_out:v1",
        actorType: "client",
        provider: "telnyx",
        providerMessageId: "message-1",
        eventKey: "inbound:telnyx:message-1:revoked",
      }),
    ).resolves.toBe(false);
  });

  it("fails a required staff event so its transaction cannot commit unaudited", async () => {
    const returning = vi.fn(async () => []);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));

    await expect(
      appendRequiredSmsConsentEventInTransaction({ insert } as never, {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        destinationE164: "+15555550123",
        action: "granted",
        source: "staff_attested_form:v1",
        disclosureVersion: "v1",
        disclosure: "Exact disclosure",
        actorType: "staff",
        actorUserId: "00000000-0000-0000-0000-000000000001",
        actorName: "Test User",
        eventKey: "staff:collision",
      }),
    ).rejects.toThrow("SMS consent evidence event could not be appended");
  });

  it("persists normalized evidence snapshots without caller-owned updates", async () => {
    const returning = vi.fn(async () => [{ id: "event-1" }]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));

    await expect(
      appendSmsConsentEventInTransaction({ insert } as never, {
        practiceId: "00000000-0000-0000-0000-0000000000aa",
        clientId: "00000000-0000-0000-0000-000000000003",
        destinationE164: "+15555550123",
        action: "granted",
        source: "staff_attested_form:v1",
        disclosureVersion: "v1",
        disclosure: "Exact disclosure",
        actorType: "staff",
        actorUserId: "00000000-0000-0000-0000-000000000001",
        actorName: "Test User",
        eventKey: "staff:event-1",
      }),
    ).resolves.toBe(true);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationE164: "+15555550123",
        action: "granted",
        disclosure: "Exact disclosure",
        occurredAt: expect.any(Date),
      }),
    );
  });

  it("bounds free-form detail before it reaches the database constraint", async () => {
    const returning = vi.fn(async () => [{ id: "event-1" }]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));

    await appendSmsConsentEventInTransaction({ insert } as never, {
      practiceId: "00000000-0000-0000-0000-0000000000aa",
      destinationE164: "+15555550123",
      action: "revoked",
      source: "inbound_opt_out:v1",
      detail: "x".repeat(SMS_CONSENT_EVENT_DETAIL_MAX_LENGTH + 500),
      actorType: "client",
      provider: "telnyx",
      providerMessageId: "message-long",
      eventKey: "inbound:telnyx:message-long:revoked",
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "x".repeat(SMS_CONSENT_EVENT_DETAIL_MAX_LENGTH),
      }),
    );
  });
});
