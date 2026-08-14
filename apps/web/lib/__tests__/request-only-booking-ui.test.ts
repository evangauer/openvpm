import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("request-only booking UI", () => {
  const publicPage = readFileSync("app/book/[slug]/page.tsx", "utf8");
  const settingsTab = readFileSync(
    "components/settings/booking-tab.tsx",
    "utf8",
  );
  const portalPage = readFileSync("app/portal/[token]/book/page.tsx", "utf8");
  const activationChecklist = readFileSync(
    "components/dashboard/activation-checklist.tsx",
    "utf8",
  );
  const allSetStep = readFileSync(
    "components/onboarding/steps/all-set.tsx",
    "utf8",
  );
  const firstDayRecommendations = readFileSync(
    "components/onboarding/first-day-recommendations.tsx",
    "utf8",
  );

  it("describes every public submission as a request that the clinic confirms", () => {
    expect(publicPage).toContain("Request an appointment");
    expect(publicPage).toContain("Request sent!");
    expect(publicPage).toContain("Request appointment");
    expect(publicPage).toContain("The clinic will review your request");
    expect(publicPage).not.toContain("You're booked!");
    expect(publicPage).not.toContain('"Book appointment"');
    expect(publicPage).not.toContain("`Book ${selectedType.name}`");
  });

  it("removes auto-confirm from settings and explains the staff handoff", () => {
    expect(settingsTab).toContain("Online appointment requests");
    expect(settingsTab).toContain(
      "Requests are never confirmed automatically.",
    );
    expect(settingsTab).toContain("assigns a doctor and room as needed");
    expect(settingsTab).not.toContain("Confirm bookings automatically");
    expect(settingsTab).not.toContain("config.autoConfirm");
  });

  it("requires an explicitly selected requestable type on both public forms", () => {
    expect(publicPage).toContain("typeId &&");
    expect(publicPage).toContain(
      "{ enabled: !!slug && !!date && !!typeId && !!locationId }",
    );
    expect(publicPage).toContain("Choose a visit type");
    expect(publicPage).not.toContain("General visit");

    expect(portalPage).toContain("hasValidAppointmentType");
    expect(portalPage).toContain("appointmentTypes.length === 0");
    expect(portalPage).toContain("Appointment requests are unavailable");
    expect(portalPage).toContain("typeId,");
    expect(portalPage).not.toContain("General visit");
  });

  it("associates public form labels and exposes time choices as radios", () => {
    for (const field of [
      "typeFieldId",
      "locationFieldId",
      "dateFieldId",
      "firstNameFieldId",
      "lastNameFieldId",
      "emailFieldId",
      "phoneFieldId",
      "websiteFieldId",
      "petNameFieldId",
      "speciesFieldId",
      "reasonFieldId",
    ]) {
      expect(publicPage).toContain(`htmlFor={${field}}`);
      expect(publicPage).toContain(`id={${field}}`);
    }
    expect(publicPage).toContain("<fieldset>");
    expect(publicPage).toContain("<legend");
    expect(publicPage).toContain('type="radio"');

    for (const field of [
      "patientFieldId",
      "typeFieldId",
      "locationFieldId",
      "dateFieldId",
      "timeFieldId",
      "reasonFieldId",
    ]) {
      expect(portalPage).toContain(`htmlFor={${field}}`);
      expect(portalPage).toContain(`id={${field}}`);
    }
  });

  it("shows an explicit unconfirmed request receipt", () => {
    expect(publicPage).toContain("Requested — not yet confirmed");
    expect(portalPage).toContain("Requested — not yet confirmed");
    expect(publicPage).toContain("Preferred time");
    expect(portalPage).toContain("Preferred time");
  });

  it("associates booking settings labels with their controls", () => {
    for (const id of [
      "booking-page-slug",
      "booking-minimum-notice",
      "booking-window",
      "booking-welcome-message",
      "booking-accent-color",
    ]) {
      expect(settingsTab).toContain(`htmlFor="${id}"`);
      expect(settingsTab).toContain(`id="${id}"`);
    }
  });

  it("blocks misleading publication and explains how to resolve it", () => {
    expect(settingsTab).toContain("nextPublished && bookableSet.size === 0");
    expect(settingsTab).toContain(
      "Select at least one active visit type before publishing",
    );
    expect(settingsTab).toContain('role="alert"');
  });

  it("fails closed until saved booking settings are available", () => {
    expect(settingsTab).toContain("pageSettingsUnavailable");
    expect(settingsTab).toContain(
      "Appointment request settings could not be loaded",
    );
    expect(settingsTab).toContain(
      "Nothing can be changed until the saved settings are available.",
    );
    expect(settingsTab).toContain("onClick={() => void myPage.refetch()}");
    expect(settingsTab).toContain("Retry loading settings");
    expect(settingsTab).toContain("appointmentTypesUnavailable");
    expect(settingsTab).toContain("Active visit types could not be loaded");
    expect(settingsTab).toContain(
      "Publishing and editing are unavailable so saved selections are",
    );
    expect(settingsTab).toContain("onClick={() => void types.refetch()}");
    expect(settingsTab).toContain("Retry loading visit types");
  });

  it("calls guided setup complete without claiming the clinic is ready to switch", () => {
    expect(activationChecklist).toContain("Guided setup checks complete");
    expect(activationChecklist).toContain("Configure appointment requests");
    expect(activationChecklist).toContain(
      "Choose which visit types and times clients can request, then publish the page.",
    );
    expect(activationChecklist).toContain(
      "Keep validating real clinic workflows with your team before",
    );
    expect(activationChecklist).not.toContain("is ready to run");
    expect(allSetStep).toContain("Add the first real client");
    expect(allSetStep).toContain(
      "Start with one real appointment, then decide what deserves a larger rollout.",
    );
    expect(allSetStep).toContain("FirstDayRecommendations");
    expect(firstDayRecommendations).toContain(
      "Here’s what I think will help first.",
    );
    expect(firstDayRecommendations).toContain("Make getting paid easy");
    expect(firstDayRecommendations).toContain("Get paid faster");
    expect(firstDayRecommendations).not.toContain("Useful for every clinic");
    expect(firstDayRecommendations).toContain(
      "pay by card from their private link",
    );
    expect(firstDayRecommendations).not.toContain("ACH");
    expect(allSetStep).not.toContain("Your workspace is ready");
  });
});
