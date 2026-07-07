import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dashboard onboarding UI states", () => {
  const activationSource = readFileSync(
    "components/dashboard/activation-checklist.tsx",
    "utf8"
  );
  const welcomeSource = readFileSync(
    "components/dashboard/welcome-panel.tsx",
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
    expect(activationSource).toContain(
      "const loadError = state.error ?? onboarding.error ?? practice.error ?? sub.error"
    );
    expect(activationSource).toContain("Setup checklist could not load");
    expect(activationSource).toContain("const isChecklistLoading");
    expect(activationSource).toContain("practice.isLoading");
    expect(activationSource).toContain(
      "if (isChecklistLoading) return <ActivationChecklistLoading />"
    );
    expect(activationSource).toContain(
      "if (!state.data || !onboarding.data || !practice.data || !sub.data)"
    );
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
      activationSource.indexOf(
        "if (!state.data || !onboarding.data || !practice.data || !sub.data)"
      )
    );
    expect(
      activationSource.indexOf(
        "if (!state.data || !onboarding.data || !practice.data || !sub.data)"
      )
    ).toBeLessThan(activationSource.indexOf("const practiceData = practice.data"));
    expect(activationSource).toContain("const checklistState = state.data");
    expect(activationSource).toContain("const onboardingData = onboarding.data");
    expect(activationSource).toContain("const practiceData = practice.data");
    expect(activationSource).toContain("const subscriptionData = sub.data");
    expect(activationSource).toContain(
      "const practiceName = practiceData.name ?? \"your practice\""
    );
    expect(activationSource).toContain("done: !!practiceData.logoUrl || !!brandColor");
    expect(activationSource).not.toContain("practice.data?.");
    expect(activationSource).not.toContain("sub.data.");
    expect(activationSource).not.toContain("onboarding.data.hasDemoData");
  });

  it("surfaces welcome panel loading and missing-data states before welcome copy", () => {
    expect(welcomeSource).toContain('import { useSession } from "next-auth/react"');
    expect(welcomeSource).toContain(
      "const { data: session, status } = useSession()"
    );
    expect(welcomeSource).toContain(
      'status === "authenticated" && session?.user?.role === "admin"'
    );
    expect(welcomeSource).toContain("enabled: show && isAdmin");
    expect(welcomeSource).toContain("if (!show || !isAdmin) return null");
    expect(settingsRouter).toContain("getPractice: adminProcedure.query");
    expect(settingsRouter).toContain("onboardingStatus: adminProcedure.query");
    expect(welcomeSource).toContain("const loadError = practice.error ?? onboarding.error");
    expect(welcomeSource).toContain("function WelcomePanelLoading");
    expect(welcomeSource).toContain("function WelcomePanelError");
    expect(welcomeSource).toContain("function retryWelcomeDetails");
    expect(welcomeSource).toContain("Welcome details could not load");
    expect(welcomeSource).toContain("practice.refetch()");
    expect(welcomeSource).toContain("onboarding.refetch()");
    expect(welcomeSource).toContain("const isWelcomeLoading");
    expect(welcomeSource).toContain("practice.isLoading || onboarding.isLoading");
    expect(welcomeSource).toContain(
      "if (isWelcomeLoading) return <WelcomePanelLoading onDismiss={dismiss} />"
    );
    expect(welcomeSource).toContain("if (!practice.data || !onboarding.data)");
    expect(welcomeSource).toContain(
      "Welcome details were unavailable. Try loading them again."
    );
    expect(welcomeSource).toContain("const hasSample = onboarding.data.hasDemoData");
    expect(welcomeSource).not.toContain("onboarding.data?.hasDemoData ?? true");
    expect(welcomeSource).not.toContain("practice.data?.name?.trim()");
    expect(welcomeSource.indexOf("if (loadError)")).toBeLessThan(
      welcomeSource.indexOf("if (isWelcomeLoading)")
    );
    expect(welcomeSource.indexOf("if (isWelcomeLoading)")).toBeLessThan(
      welcomeSource.indexOf("if (!practice.data || !onboarding.data)")
    );
    expect(welcomeSource.indexOf("if (!practice.data || !onboarding.data)")).toBeLessThan(
      welcomeSource.indexOf("const hasSample = onboarding.data.hasDemoData")
    );
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
    expect(journeyProviderSource).toContain("<JourneyShell steps={steps}");
    expect(journeyProviderSource).toContain(
      "trpc.settings.completeOnboarding.useMutation"
    );
    expect(journeyProviderSource).toContain(
      "trpc.settings.clearDemoData.useMutation"
    );
    expect(settingsRouter).toContain("completeOnboarding: adminProcedure.mutation");
    expect(settingsRouter).toContain("clearDemoData: adminProcedure.mutation");
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
