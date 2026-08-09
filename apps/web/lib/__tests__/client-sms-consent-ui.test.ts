import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const NEW_CLIENT_SOURCE = readFileSync(
  new URL("../../app/(dashboard)/clients/new/page.tsx", import.meta.url),
  "utf8",
);
const EDIT_CLIENT_SOURCE = readFileSync(
  new URL("../../app/(dashboard)/clients/[id]/edit/page.tsx", import.meta.url),
  "utf8",
);

describe("client SMS consent forms", () => {
  it("renders the shared server-owned disclosure in both forms", () => {
    for (const source of [NEW_CLIENT_SOURCE, EDIT_CLIENT_SOURCE]) {
      expect(source).toContain("SMS_CONSENT_DISCLOSURE.snapshot");
      expect(source).toContain(
        "I confirm the client explicitly consented to SMS",
      );
      expect(source).toContain("read this disclosure");
    }
  });

  it("does not resubmit persisted edit consent on unrelated saves", () => {
    expect(EDIT_CLIENT_SOURCE).toContain("smsConsentTouched");
    expect(EDIT_CLIENT_SOURCE).toContain(
      "...(smsConsentTouched ? { smsConsent } : {})",
    );
    expect(EDIT_CLIENT_SOURCE).toContain("phoneNumbersMatchForConsent");
    expect(EDIT_CLIENT_SOURCE).toContain("setSmsConsentTouched(false)");
  });

  it("offers an explicit text-reminder preference in both client forms", () => {
    for (const source of [NEW_CLIENT_SOURCE, EDIT_CLIENT_SOURCE]) {
      expect(source).toContain("Preferred contact for reminders");
      expect(source).toContain('<option value="sms">Text message</option>');
      expect(source).toContain("appointment and vaccination reminders");
      expect(source).toContain("preferredContactMethod");
    }
    expect(NEW_CLIENT_SOURCE).toContain("preferredContactMethod,");
    expect(EDIT_CLIENT_SOURCE).toContain("preferredContactTouched");
    expect(EDIT_CLIENT_SOURCE).toContain(
      "...(preferredContactTouched ? { preferredContactMethod } : {})",
    );
  });

  it("requires consent readiness when staff chooses text reminders", () => {
    expect(NEW_CLIENT_SOURCE).toContain(
      'preferredContactMethod !== "sms" || (smsConsent && smsPhoneValid)',
    );
    expect(EDIT_CLIENT_SOURCE).toContain("smsPreferenceReady");
    expect(EDIT_CLIENT_SOURCE).toContain("smsPreferenceNeedsValidation");
    expect(NEW_CLIENT_SOURCE).toContain(
      'current === "sms" ? "phone" : current',
    );
    expect(EDIT_CLIENT_SOURCE).toContain('setPreferredContactMethod("phone")');
  });

  it("cannot revoke a different unsaved phone than the persisted destination", () => {
    expect(EDIT_CLIENT_SOURCE).toContain(
      "const persistedSmsPhone = normalizeE164(client?.phone)",
    );
    expect(EDIT_CLIENT_SOURCE).toContain(
      "!persistedSmsPhone || phoneChanged || revokeSms.isPending",
    );
    expect(EDIT_CLIENT_SOURCE).toContain("expectedPhone: persistedSmsPhone!");
    expect(EDIT_CLIENT_SOURCE).toContain(
      "Save or discard the unsaved phone change",
    );
  });
});
