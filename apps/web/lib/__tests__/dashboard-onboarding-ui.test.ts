import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard onboarding UI states", () => {
  const activationSource = readFileSync(
    "components/dashboard/activation-checklist.tsx",
    "utf8"
  );
  const tourProviderSource = readFileSync(
    "components/tour/tour-provider.tsx",
    "utf8"
  );
  const journeyProviderSource = readFileSync(
    "components/onboarding/journey-overlay.tsx",
    "utf8"
  );
  const settingsRouter = readFileSync("server/routers/settings.ts", "utf8");

  it("surfaces activation checklist query failures before hiding for missing data", () => {
    expect(activationSource).toContain("function ActivationChecklistError");
    expect(activationSource).toContain("function ActivationChecklistLoading");
    expect(activationSource).toContain("const loadError =");
    expect(activationSource).toContain("Setup checklist could not load");
    expect(activationSource).toContain("const isChecklistLoading");
    expect(activationSource).toContain("practice.isLoading");
    expect(activationSource).toContain(
      "if (isChecklistLoading) return <ActivationChecklistLoading />"
    );
    expect(activationSource).toContain("!clientPayments.data");
    expect(activationSource).toContain(
      "Setup checklist data was unavailable. Try loading it again."
    );
    expect(activationSource).toContain("state.refetch()");
    expect(activationSource).toContain("onboarding.refetch()");
    expect(activationSource).toContain("practice.refetch()");
    expect(activationSource).toContain("sub.refetch()");
    expect(activationSource.indexOf("if (loadError)")).toBeLessThan(
      activationSource.indexOf("if (isChecklistLoading)")
    );
    expect(activationSource.indexOf("if (isChecklistLoading)")).toBeLessThan(
      activationSource.indexOf("!clientPayments.data")
    );
    expect(activationSource.indexOf("!clientPayments.data")).toBeLessThan(
      activationSource.indexOf("const practiceData = practice.data")
    );
    expect(activationSource).toContain("const checklistState = state.data");
    expect(activationSource).toContain("const onboardingData = onboarding.data");
    expect(activationSource).toContain("const practiceData = practice.data");
    expect(activationSource).toContain("const subscriptionData = sub.data");
    expect(activationSource).toContain(
      "const practiceName = practiceData.name ?? \"your practice\""
    );
    expect(activationSource).toContain("done: !!practiceData.logoUrl || !!brandColor");
    expect(activationSource).toContain(
      "done: onboardingData.hasRealData"
    );
    expect(activationSource).toContain('label: "Publish online booking"');
    expect(activationSource).toContain(
      "done: bookingData.page?.published === true"
    );
    expect(activationSource).toContain('label: "Start texting registration"');
    expect(activationSource).toContain("done: textingData.hasAnyNumber");
    expect(activationSource).toContain('label: "Add one real client and pet"');
    expect(activationSource).toContain('href: "/clients/new"');
    expect(activationSource).toContain(
      'label: "Book that pet\'s first appointment"'
    );
    expect(activationSource).toContain(
      "done: onboardingData.hasRealAppointment"
    );
    expect(activationSource).toContain('label: "Set up client card payments"');
    expect(activationSource).toContain("done: clientPaymentData.enabled");
    expect(activationSource).toContain('pathway.value === "explore"');
    expect(activationSource).not.toContain("practice.data?.");
    expect(activationSource).not.toContain("sub.data.");
    expect(activationSource).not.toContain("onboarding.data.hasDemoData");
  });

  it("retired the dormant welcome panel in favor of the welcome surface", () => {
    // The old ?welcome=1 panel is gone; the dashboard leads with the
    // activation checklist, and greeting lives in components/welcome/.
    const dashboardSource = readFileSync("app/(dashboard)/page.tsx", "utf8");
    expect(dashboardSource).not.toContain("WelcomePanel");
    expect(dashboardSource).toContain("<ActivationChecklist />");
  });

  it("keeps tour setup persistence admin-only at the provider boundary", () => {
    expect(tourProviderSource).toContain('import { useSession } from "next-auth/react"');
    expect(tourProviderSource).toContain(
      'status === "authenticated" && session?.user?.role === "admin"'
    );
    expect(tourProviderSource).toContain("enabled: isAdmin");
    expect(tourProviderSource).toContain("if (!isAdmin) return;");
    expect(tourProviderSource).toContain(
      "setTourStatus.mutate({ status, lastStepId: stepId ?? null })"
    );
    expect(settingsRouter).toContain("setTourStatus: adminProcedure");
  });

  it("keeps guided setup overlay mutations admin-only at the provider boundary", () => {
    expect(journeyProviderSource).toContain('import { useSession } from "next-auth/react"');
    expect(journeyProviderSource).toContain(
      'status === "authenticated" && session?.user?.role === "admin"'
    );
    expect(journeyProviderSource).toContain("const openJourney = useCallback(() => {");
    expect(journeyProviderSource).toContain("if (!isAdmin) return;");
    expect(journeyProviderSource).toContain("const isOpen = isAdmin && index !== null");
    expect(journeyProviderSource).toContain("value={{ openJourney, isOpen }}");
    expect(journeyProviderSource).toMatch(/<JourneyShell\s+steps=\{steps\}/);
    expect(journeyProviderSource).toContain("disabled={busy || continueDisabled}");
    expect(journeyProviderSource).toContain(
      "trpc.settings.completeOnboarding.useMutation"
    );
    expect(journeyProviderSource).toContain(
      "trpc.settings.clearDemoData.useMutation"
    );
    expect(settingsRouter).toContain("completeOnboarding: adminProcedure.mutation");
    expect(settingsRouter).toContain("clearDemoData: adminProcedure.mutation");
    expect(settingsRouter).toContain("setOnboardingIntent: adminProcedure");
  });

  it("uses the selected pathway to put a tailored first win first", () => {
    expect(activationSource).toContain("getOnboardingIntentOption");
    expect(activationSource).toContain("pathway.firstWinTarget");
    expect(activationSource).toContain("label: pathway.firstWin");
    expect(activationSource).toContain("hint: pathway.firstWinHint");
    expect(activationSource).toContain("{pathway.shortLabel} · {doneCount}");
  });

  it("turns the activation checklist into a mobile first-win path with a persisted help request", () => {
    expect(activationSource).toContain(
      "trpc.settings.requestOnboardingHelp.useMutation"
    );
    expect(activationSource).toContain("Help me set this up");
    expect(activationSource).toContain("Setup help requested");
    expect(activationSource).toContain("setupHelpRequestedAt");
    expect(activationSource).toContain(
      "relative z-20 w-full sm:fixed sm:bottom-4"
    );
    expect(activationSource).not.toContain(
      "fixed bottom-4 right-4 z-[70] hidden"
    );
    expect(settingsRouter).toContain(
      "requestOnboardingHelp: adminProcedure.mutation"
    );
    expect(settingsRouter).toContain('"Hands-on onboarding requested"');
  });

  it("auto-opens the wizard for unfinished, non-dismissed onboarding and resumes durably", () => {
    // Auto-open gate: only when onboarding is not finished and not dismissed.
    expect(journeyProviderSource).toContain(
      "onboardingStatus.data.completedAt == null"
    );
    expect(journeyProviderSource).toContain(
      "onboardingState.data.journeyDismissed === true"
    );
    expect(journeyProviderSource).toContain(
      "if (notFinished && !dismissed && !established)"
    );
    // Established practices (seeded demo, self-host upgrades) are never
    // greeted like new signups even without a recorded completion date.
    expect(journeyProviderSource).toContain(
      "onboardingStatus.data.establishedPractice === true"
    );
    expect(settingsRouter).toContain("ESTABLISHED_PRACTICE_PATIENT_THRESHOLD");
    // Resume from the durable cursor rather than always step 0.
    expect(journeyProviderSource).toContain(
      "steps.findIndex((s) => s.id === journeyStepId)"
    );
    expect(journeyProviderSource).toContain("setIndex(resumeIndex)");
    // "I'll finish later" records dismissal WITHOUT completing onboarding.
    expect(journeyProviderSource).toContain(
      "setJourneyProgress.mutate({ stepId: step.id, dismissed: true })"
    );
    expect(settingsRouter).toContain("setJourneyProgress: adminProcedure");
  });
});
