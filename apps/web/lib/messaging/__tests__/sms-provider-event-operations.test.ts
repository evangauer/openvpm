import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hasBlockingSmsProviderEventForDispatchInTransaction } from "../sms-provider-event-operations";

const source = readFileSync(
  new URL("../sms-provider-event-operations.ts", import.meta.url),
  "utf8",
);

describe("SMS provider-event operational gates", () => {
  it("uses provider-qualified sender identities and preserves quarantine as a separate blocker", () => {
    expect(source).toContain("event.provider = sender.provider");
    expect(source).toContain(
      "event.state in ('pending', 'retry', 'blocked_recovery', 'quarantined')",
    );
    expect(source).toContain("sms_provider_event_conflict_reviews");
    expect(source).toContain("review.conflict_id = conflict.id");
  });

  it("blocks unattributed provider risk when either live sender identity contradictor matches", () => {
    const barrier = source.slice(
      source.indexOf(
        "export async function hasBlockingSmsProviderEventForDispatchInTransaction",
      ),
      source.indexOf("type GateSummaryRow"),
    );
    expect(barrier).toContain("event.practice_id is null");
    expect(barrier).toContain("sender.provider = event.provider");
    expect(barrier).toContain("event.to_e164 = sender.sender_e164");
    expect(barrier).toContain(
      "event.messaging_profile_id = sender.messaging_profile_id",
    );
    expect(barrier).toContain("event.kind = 'a2p'");
    expect(barrier).toContain("event.state = 'quarantined'");
    expect(barrier).toContain("sms_provider_event_resolutions");
    expect(barrier).toContain("sms_provider_event_conflict_reviews");
  });

  it("keeps the operator queue PHI-free at its SQL projection boundary", () => {
    const queueSource = source.slice(
      source.indexOf("export async function loadSmsProviderEventQueue"),
    );
    expect(queueSource).not.toMatch(
      /select[\s\S]{0,300}(message_body|from_e164|to_e164|provider_detail)/i,
    );
    expect(queueSource).not.toContain('"messageBody"');
    expect(queueSource).not.toContain('"fromE164"');
    expect(queueSource).not.toContain('"toE164"');
  });

  it("fails the final dispatch barrier on an exact durable STOP", async () => {
    const execute = vi.fn(async () => ({ rows: [{ blocked: true }] }));

    await expect(
      hasBlockingSmsProviderEventForDispatchInTransaction(
        { execute } as never,
        "00000000-0000-4000-8000-0000000000aa",
        "+15555550199",
      ),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});
