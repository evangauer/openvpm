import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isMessagingAreaCodeInputValid,
  isMessagingPhoneInputValid,
  MESSAGING_AREA_CODE_LENGTH,
  MESSAGING_PHONE_MAX_LENGTH,
  MESSAGING_PHONE_MIN_LENGTH,
  MESSAGING_SEARCH_LIMIT_MAX,
} from "../messaging/policy";

describe("messaging settings UI", () => {
  const tabSource = readFileSync(
    "components/settings/messaging-tab.tsx",
    "utf8"
  );
  const wizardSource = readFileSync(
    "components/settings/messaging-wizard.tsx",
    "utf8"
  );
  const routerSource = readFileSync("server/routers/messaging.ts", "utf8");
  const onboardingSource = readFileSync(
    "components/onboarding/steps/set-up-texting.tsx",
    "utf8"
  );

  it("keeps messaging phone policy aligned across settings and router", () => {
    expect(MESSAGING_PHONE_MIN_LENGTH).toBe(7);
    expect(MESSAGING_PHONE_MAX_LENGTH).toBe(32);
    expect(MESSAGING_AREA_CODE_LENGTH).toBe(3);
    expect(MESSAGING_SEARCH_LIMIT_MAX).toBe(20);
    expect(isMessagingPhoneInputValid("(555) 555-0100")).toBe(true);
    expect(isMessagingPhoneInputValid("+1 555 555 0100")).toBe(true);
    expect(isMessagingPhoneInputValid("12345")).toBe(false);
    expect(isMessagingPhoneInputValid("1".repeat(33))).toBe(false);
    expect(isMessagingAreaCodeInputValid("")).toBe(true);
    expect(isMessagingAreaCodeInputValid("415")).toBe(true);
    expect(isMessagingAreaCodeInputValid("41")).toBe(false);
    expect(routerSource).toContain("MESSAGING_PHONE_MIN_LENGTH");
    expect(routerSource).toContain("MESSAGING_PHONE_MAX_LENGTH");
    expect(routerSource).toContain("MESSAGING_AREA_CODE_LENGTH");
    expect(routerSource).toContain("MESSAGING_SEARCH_LIMIT_MAX");
  });

  it("gates messaging setup and test-send controls before server rejection", () => {
    expect(tabSource).toContain("function hasConfiguredSender");
    expect(tabSource).toContain("messaging.senderE164?.trim()");
    expect(tabSource).toContain("messaging.messagingProfileId?.trim()");
    expect(tabSource).toContain("const canEnableSending =");
    expect(tabSource).toContain('m.registrationStatus === "active"');
    expect(tabSource).toContain("hasConfiguredSender(m)");
    expect(tabSource).toContain("m.launchEligible !== false");
    expect(tabSource).toContain(
      "m.providerProfileAttestationFresh !== false",
    );
    expect(tabSource).toContain("waitingForProviderVerification");
    expect(tabSource).toContain("Provider safety check required");
    expect(tabSource).toContain("does not need to repeat carrier");
    expect(tabSource).toContain("registration; this operational check");
    expect(routerSource).toContain(
      "providerProfileReady: locationMessaging.providerProfileReady",
    );
    expect(routerSource).toContain("providerProfileAttestationFresh:");
    expect(routerSource).toContain(
      "HOSTED_PROVIDER_PROFILE_ATTESTATION_MAX_AGE_MS",
    );
    expect(tabSource).toContain("testSendAllowed &&");
    expect(tabSource).toContain("isMessagingPhoneInputValid(testTo)");
    expect(tabSource).toContain("maxLength={MESSAGING_PHONE_MAX_LENGTH}");
    expect(tabSource).toContain(
      "disabled={setEnabled.isPending || (!m.enabled && !canEnableSending)}"
    );
    expect(tabSource).toContain(
      "disabled={!canSendTest || testSend.isPending}"
    );
    expect(tabSource).toContain("to: testTo.trim()");
    expect(tabSource).toContain("Outbound texting is safely off");
    expect(tabSource).toContain("Arbitrary test destinations are disabled");
    expect(wizardSource).toContain("MESSAGING_AREA_CODE_LENGTH");
    expect(wizardSource).toContain("isMessagingAreaCodeInputValid(areaCode)");
    expect(wizardSource).toContain(
      "disabled={checking || !isMessagingAreaCodeInputValid(areaCode)}"
    );
    expect(wizardSource).toContain(
      "validate through a current consented client workflow"
    );
    expect(wizardSource).not.toContain("send a test from the active location");
    expect(tabSource).toContain("<MessagingRegistrationForm />");
    expect(wizardSource).not.toContain("trpc.messaging.testSend.useMutation");
    expect(wizardSource).not.toContain("isMessagingPhoneInputValid(testTo)");
    expect(wizardSource).not.toContain(
      "maxLength={MESSAGING_PHONE_MAX_LENGTH}"
    );
    expect(wizardSource).not.toContain("to: testTo.trim()");
    expect(wizardSource).not.toContain("Send test");
  });

  it("surfaces messaging status query failures and missing payloads before showing placeholder stats", () => {
    expect(tabSource).toContain("error, refetch");
    expect(tabSource).toContain("function MessagingLoadError");
    expect(tabSource).toContain("if (error)");
    expect(tabSource).toContain("if (!data)");
    expect(tabSource).toContain("Unable to load messaging settings");
    expect(tabSource).toContain("Messaging status is unavailable");
    expect(tabSource).toContain("onRetry={() => void refetch()}");
    expect(tabSource.indexOf("if (error)")).toBeLessThan(
      tabSource.indexOf("if (!data)")
    );
    expect(tabSource.indexOf("if (!data)")).toBeLessThan(
      tabSource.indexOf("const usage = data.usage")
    );
    expect(tabSource).toContain(
      "const locations = data.locations as MessagingSetupLocation[]"
    );
    expect(tabSource).not.toContain("data?.locations ?? []");
    expect(tabSource).not.toContain("const usage = data?.usage");
    expect(tabSource).not.toContain("const consent = data?.consent");
  });

  it("is explicit about unsupported existing numbers, charges, and recoverable setup", () => {
    expect(wizardSource).toContain(
      "Existing-number texting is not available yet"
    );
    expect(wizardSource).toContain("will not be ported, hosted, or changed");
    expect(wizardSource).toContain("chargeAcknowledged");
    expect(wizardSource).toContain(
      "I authorize the exact upfront and monthly provider charges"
    );
    expect(wizardSource).toContain("confirmProviderCharges: true");
    expect(wizardSource).toContain(
      '(step === "registration" &&\n      mode === "buy" &&\n      Boolean(selectedNumber) &&\n      chargeAcknowledged)'
    );
    expect(wizardSource).toContain("upfrontCost");
    expect(wizardSource).toContain("monthlyCost");
    expect(wizardSource).toContain("currency");
    expect(wizardSource).toContain("Purchase number and start setup");
    expect(tabSource).toContain("Reconcile provider setup");
    expect(tabSource).toContain('action: "resume"');
    expect(onboardingSource).not.toContain(
      "You can text from your existing number"
    );
    expect(onboardingSource).toContain("Number order accepted");
    expect(onboardingSource).toContain("Carrier registration is under review");
    expect(onboardingSource).toContain("Carrier registration is approved");
    expect(onboardingSource).toContain("Number setup did not finish");
    expect(routerSource).toContain("pg_advisory_xact_lock");
    expect(routerSource).toContain("assertProvisioningEnabled();");
    expect(routerSource).toContain("confirmProviderCharges: z.literal(true)");
    expect(routerSource).toContain("findNumberOrdersByCustomerReference");
  });
});
