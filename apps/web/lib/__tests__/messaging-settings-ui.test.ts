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
    "utf8",
  );
  const wizardSource = readFileSync(
    "components/settings/messaging-wizard.tsx",
    "utf8",
  );
  const registrationSource = readFileSync(
    "components/settings/messaging-registration-form.tsx",
    "utf8",
  );
  const routerSource = readFileSync("server/routers/messaging.ts", "utf8");
  const onboardingSource = readFileSync(
    "components/onboarding/steps/set-up-texting.tsx",
    "utf8",
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
    expect(tabSource).toContain("m.providerProfileAttestationFresh !== false");
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
      "disabled={setEnabled.isPending || (!m.enabled && !canEnableSending)}",
    );
    expect(tabSource).toContain(
      "disabled={!canSendTest || testSend.isPending}",
    );
    expect(tabSource).toContain("to: testTo.trim()");
    expect(tabSource).toContain("Outbound texting is safely off");
    expect(tabSource).toContain("Arbitrary test destinations are disabled");
    expect(tabSource).toContain("data.launch.setupAvailable");
    expect(tabSource).toContain("Texting is a controlled clinic pilot");
    expect(tabSource).toContain(
      "OpenVPM will not\n            search for or purchase a number",
    );
    expect(tabSource).toContain(
      "Email appointment reminders remain\n            available",
    );
    expect(tabSource).toContain(
      "{data.launch.setupAvailable ? (\n        <MessagingWizard",
    );
    expect(tabSource).toContain(
      "{setupAvailable ? (\n          <Button onClick={onStartSetup}",
    );
    expect(wizardSource).toContain("MESSAGING_AREA_CODE_LENGTH");
    expect(wizardSource).toContain("isMessagingAreaCodeInputValid(areaCode)");
    expect(wizardSource).toContain(
      "disabled={checking || !isMessagingAreaCodeInputValid(areaCode)}",
    );
    expect(wizardSource).toContain(
      "validate through a current consented client workflow",
    );
    expect(wizardSource).not.toContain("send a test from the active location");
    expect(tabSource).toContain("<MessagingRegistrationForm />");
    expect(tabSource).toContain(
      "data.launch.setupAvailable ||\n      locations.some((location) => location.messaging)",
    );
    expect(tabSource).toContain(
      "Number setup is disabled by your OpenVPM administrator",
    );
    expect(tabSource).toContain("hosted={data.launch.hosted}");
    expect(wizardSource).toContain("hosted: boolean");
    expect(wizardSource).toContain(
      "<ConfirmStep\n                hosted={hosted}",
    );
    expect(wizardSource).toContain(
      'hosted\n          ? "OpenVPM reviews them."\n          : "your administrator finishes provider activation."',
    );
    expect(wizardSource).toContain(
      "Your administrator must finish provider activation",
    );
    expect(wizardSource).toContain("Hosted sending remains off");
    expect(registrationSource).toContain(
      "Carrier registration details saved for administrator review.",
    );
    expect(registrationSource).toContain(
      "your messaging administrator reviews it first.",
    );
    expect(registrationSource).not.toContain("an OpenVPM operator reviews it");
    expect(tabSource).toContain(
      "OpenVPM support must review this failed pilot setup",
    );
    expect(routerSource).toContain(
      "!existing && !provisioningAvailableForPractice(ctx.practiceId)",
    );
    expect(wizardSource).not.toContain("trpc.messaging.testSend.useMutation");
    expect(wizardSource).not.toContain("isMessagingPhoneInputValid(testTo)");
    expect(wizardSource).not.toContain(
      "maxLength={MESSAGING_PHONE_MAX_LENGTH}",
    );
    expect(wizardSource).not.toContain("to: testTo.trim()");
    expect(wizardSource).not.toContain("Send test");
  });

  it("keeps automatic reminders explicit, constrained, and off by default", () => {
    expect(tabSource).toContain("Automatic appointment reminders");
    expect(tabSource).toContain("APPOINTMENT_REMINDER_LEAD_OPTIONS");
    expect(tabSource).toContain("[24, 48, 72] as const");
    expect(tabSource).toContain("setAppointmentReminderSettings");
    expect(tabSource).toContain("Off by default");
    expect(tabSource).toContain("confirmReminderCatchUp");
    expect(tabSource).toContain('!confirmReminderCatchUp("expand", leadHours)');
    expect(tabSource).toContain(
      "Enabling reminders or increasing this window may send reminders for",
    );
    expect(tabSource).toContain(
      "existing eligible confirmed appointments on the next hourly run.",
    );
    expect(routerSource).toContain("appointmentReminderLeadHoursInput");
    expect(routerSource).toContain("appointmentRemindersEnabled");
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
      tabSource.indexOf("if (!data)"),
    );
    expect(tabSource.indexOf("if (!data)")).toBeLessThan(
      tabSource.indexOf("const usage = data.usage"),
    );
    expect(tabSource).toContain(
      "const locations = data.locations as MessagingSetupLocation[]",
    );
    expect(tabSource).not.toContain("data?.locations ?? []");
    expect(tabSource).not.toContain("const usage = data?.usage");
    expect(tabSource).not.toContain("const consent = data?.consent");
  });

  it("is explicit about unsupported existing numbers, charges, and recoverable setup", () => {
    expect(wizardSource).toContain(
      "Existing-number texting is not available yet",
    );
    expect(wizardSource).toContain("will not be ported, hosted, or changed");
    expect(wizardSource).toContain("chargeAcknowledged");
    expect(wizardSource).toContain(
      "I authorize the exact upfront and monthly provider charges",
    );
    expect(wizardSource).toContain("confirmProviderCharges: true");
    expect(wizardSource).toContain(
      '(step === "registration" &&\n      mode === "buy" &&\n      Boolean(selectedNumber) &&\n      chargeAcknowledged)',
    );
    expect(wizardSource).toContain("upfrontCost");
    expect(wizardSource).toContain("monthlyCost");
    expect(wizardSource).toContain("currency");
    expect(wizardSource).toContain("Purchase number and start setup");
    expect(tabSource).toContain("Reconcile provider setup");
    expect(tabSource).toContain('action: "resume"');
    expect(onboardingSource).not.toContain(
      "You can text from your existing number",
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

  it("keeps unavailable texting setup out of the onboarding purchase flow", () => {
    expect(onboardingSource).toContain("status.data?.launch.setupAvailable");
    expect(onboardingSource).toContain(
      "const setupUnavailable = setupAvailable === false && !hasAnyNumber",
    );
    expect(onboardingSource).toContain("controlled clinic pilot");
    expect(onboardingSource).toContain("Email appointment reminders remain");
    expect(onboardingSource).toContain("const setupCapabilityKnown");
    expect(onboardingSource).toContain("{!setupCapabilityKnown ? (");
    expect(onboardingSource).toContain(
      "We are checking whether new-number setup",
    );
    expect(onboardingSource).toContain(
      "Texting number setup is disabled in this deployment",
    );
    expect(onboardingSource).toContain(
      "Your clinic has an existing texting setup to review",
    );
    expect(onboardingSource).toContain("setupDisabled && !messaging");
    expect(onboardingSource).toContain('href="/settings?tab=messaging"');
    expect(onboardingSource).toContain(
      'href="mailto:support@openvpm.com?subject=OpenVPM%20texting%20pilot"',
    );
    expect(onboardingSource).toContain("setupAvailable === false || messaging");
    expect(onboardingSource).toContain(
      "{setupAvailable ? (\n        <MessagingWizard",
    );
  });
});
