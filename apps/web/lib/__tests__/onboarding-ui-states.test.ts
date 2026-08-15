import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_INSTRUCTION_MAX_LENGTH,
  isAgentInstructionValid,
} from "../agent/policy";
import {
  PRACTICE_NAME_MAX_LENGTH,
  SETTINGS_EMAIL_MAX_LENGTH,
} from "../settings-policy";

describe("onboarding UI states", () => {
  const onboardingPage = readFileSync(
    "app/(dashboard)/onboarding/page.tsx",
    "utf8",
  );
  const practiceBasics = readFileSync(
    "components/onboarding/steps/practice-basics.tsx",
    "utf8",
  );
  const branding = readFileSync(
    "components/onboarding/steps/branding.tsx",
    "utf8",
  );
  const tryAgent = readFileSync(
    "components/onboarding/steps/try-agent.tsx",
    "utf8",
  );
  const inviteTeam = readFileSync(
    "components/onboarding/steps/invite-team.tsx",
    "utf8",
  );
  const choosePath = readFileSync(
    "components/onboarding/steps/choose-path.tsx",
    "utf8",
  );
  const clinicIntentBuilder = readFileSync(
    "components/onboarding/clinic-intent-builder.tsx",
    "utf8",
  );
  const onboardingIntent = readFileSync("lib/onboarding/intent.ts", "utf8");
  const journeyOverlay = readFileSync(
    "components/onboarding/journey-overlay.tsx",
    "utf8",
  );
  const journeyPlan = readFileSync("lib/onboarding/journey-plan.ts", "utf8");
  const settingsRouter = readFileSync("server/routers/settings.ts", "utf8");
  const dataRouter = readFileSync("server/routers/data.ts", "utf8");

  it("retires the standalone onboarding page as a redirect to the dashboard", () => {
    // The static "Your OpenVPM workspace is ready" page was replaced by the
    // auto-opening setup wizard; this route is now just a redirect stub.
    expect(onboardingPage).toContain(
      'import { redirect } from "next/navigation"',
    );
    expect(onboardingPage).toContain('redirect("/")');
    expect(onboardingPage).not.toContain("Your OpenVPM workspace is ready");
    expect(onboardingPage).not.toContain("Setup before first charge");
    expect(onboardingPage).not.toContain("function AdminOnboardingPage");
  });

  it("keeps onboarding mutations admin-only at the settings router", () => {
    expect(settingsRouter).toContain("onboardingStatus: adminProcedure.query");
    expect(settingsRouter).toContain(
      "completeOnboarding: adminProcedure.mutation",
    );
    expect(settingsRouter).toContain("clearDemoData: adminProcedure.mutation");
    expect(settingsRouter).toContain("setOnboardingIntent: adminProcedure");
    expect(settingsRouter).toContain("setJourneyProgress: adminProcedure");
    expect(settingsRouter).toContain("hasRealData: existingPatients.some(");
    expect(settingsRouter).toContain(
      "hasRealAppointment: firstRealAppointment.length > 0",
    );
    expect(settingsRouter).toContain(
      "hasCompletedRealAppointment: completedRealAppointment.length > 0",
    );
  });

  it("starts with a persisted clinic model, first outcome, and adoption pathway", () => {
    expect(journeyPlan).toContain(
      '{ id: "intent", title: "A platform truly built for your clinic." }',
    );
    expect(journeyOverlay).toContain(
      "initialIntent={onboardingIntent ?? DEFAULT_ONBOARDING_INTENT}",
    );
    expect(journeyOverlay).toContain("initialClinicModel={");
    expect(journeyOverlay).toContain("initialFirstGoal={");
    expect(onboardingIntent).toContain(
      'label: "Run alongside my current PIMS"',
    );
    expect(choosePath).toContain("clinicModel: state.clinicModel");
    expect(choosePath).toContain("firstGoal: state.firstGoal");
    expect(choosePath).toContain("Build my first day");
    expect(clinicIntentBuilder).toContain("Your first OpenVPM day");
    expect(choosePath).toContain("journeyDismissed: false");
    expect(settingsRouter).toContain("onboardingIntentSelectedAt");
    expect(settingsRouter).toContain("clinicModelSelectedAt");
    expect(settingsRouter).toContain("firstGoalSelectedAt");
  });

  it("personalizes new care models with a compact review-first plan", () => {
    expect(clinicIntentBuilder).not.toContain(
      'selectedModel.readiness === "design_partner"',
    );
    expect(clinicIntentBuilder).not.toContain("HeartPulse className");
    expect(clinicIntentBuilder).toContain("Nothing moves until you review it.");
    expect(choosePath).toContain("FUNNEL_EVENTS.onboardingModelSelected");
    expect(choosePath).toContain("FUNNEL_EVENTS.onboardingGoalSelected");
    expect(choosePath).toContain("FUNNEL_EVENTS.onboardingPlanBuilt");
  });

  it("uses the canonical OpenVPM mark, typography, and primary color tokens", () => {
    expect(journeyOverlay).toContain("import { BrandBadge }");
    expect(journeyOverlay).toContain("<BrandBadge");
    expect(journeyOverlay).toContain("font-heading text-[2.15rem]");
    expect(journeyOverlay).not.toContain("[font-family:Georgia,serif]");
    expect(journeyOverlay).not.toContain("<PawPrint");
    expect(journeyOverlay).toContain('i <= index ? "bg-primary"');
    expect(clinicIntentBuilder).toContain("focus-visible:ring-primary");
  });

  it("keeps imported-real-data cleanup sticky across setup resumes", () => {
    expect(settingsRouter).toContain("migrationHasCommittedChanges: false");
    expect(settingsRouter).toContain("migrationLastCommittedAt: null");
    expect(dataRouter).toContain("migrationHasCommittedChanges', true");
    expect(dataRouter).toContain(
      "migrationLastCommittedAt', ${committedAt}::text",
    );
    expect(journeyOverlay).toContain("initialMigrationHasCommittedChanges={");
    expect(journeyOverlay).toContain(
      "keepSampleData: !initialMigrationHasCommittedChanges",
    );
    expect(journeyOverlay).toContain(
      "hasImportedData: initialMigrationHasCommittedChanges",
    );
    expect(journeyOverlay).toContain(
      "initialMigrationSource={onboardingState.data?.migrationSource ?? null}",
    );
    expect(journeyOverlay).toContain(
      "onboardingState.data?.migrationSourceHasCommittedChanges === true",
    );
    expect(journeyOverlay).toContain("initialMigrationCompletedModes={");
  });

  it("uses a keyboard-complete modal with responsive and explained actions", () => {
    expect(journeyOverlay).toContain(
      'import * as DialogPrimitive from "@radix-ui/react-dialog"',
    );
    expect(journeyOverlay).toContain("<DialogPrimitive.Root");
    expect(journeyOverlay).toContain("<DialogPrimitive.Portal>");
    expect(journeyOverlay).toContain("<DialogPrimitive.Overlay");
    expect(journeyOverlay).toContain("<DialogPrimitive.Content");
    expect(journeyOverlay).toContain("<DialogPrimitive.Title asChild>");
    expect(journeyOverlay).toContain(
      "onInteractOutside={(event) => event.preventDefault()}",
    );
    expect(journeyOverlay).toContain("aria-describedby={");
    expect(journeyOverlay).toContain("state.hasPartialImport");
    expect(journeyOverlay).toContain('id="onboarding-back-disabled-reason"');
    expect(journeyOverlay).toContain("whitespace-normal");
    expect(journeyOverlay).toContain('"I\'ll finish later"');
    expect(journeyOverlay).not.toContain("I&apos;ll finish later");
  });

  it("surfaces guided setup query failures instead of showing default step states", () => {
    expect(practiceBasics).toContain("function OnboardingStepError");
    expect(practiceBasics).toContain("Practice details could not load");
    expect(practiceBasics).toContain("getMyClinicalProfile.useQuery()");
    expect(practiceBasics).toContain("updateMyClinicalProfile.useMutation()");
    expect(practiceBasics).toContain("void refetch();");
    expect(practiceBasics).toContain("void refetchClinicalProfile();");
    expect(practiceBasics).toContain("clinicalProfileError");
    expect(practiceBasics).toContain("ownerRoleMissing");
    expect(practiceBasics).toContain(
      'isVeterinarian: ownerRole === "veterinarian"',
    );
    expect(practiceBasics.indexOf("clinicalProfileError ||")).toBeLessThan(
      practiceBasics.indexOf("if (practiceNameInvalid) return false"),
    );

    expect(branding).toContain("error: practiceError");
    expect(branding).toContain("Saved branding could not load");
    expect(branding).toContain("onClick={() => void refetchPractice()}");
    expect(branding.indexOf("{practiceError ? (")).toBeLessThan(
      branding.indexOf("{currentLogo ? ("),
    );

    expect(tryAgent).toContain("AI helper status could not load");
    expect(tryAgent).toContain("AI helper status is unavailable");
    expect(tryAgent).toContain(
      "AI helper configuration could not be verified. Please retry before asking the helper.",
    );
    expect(tryAgent).toContain("const verifiedAgentStatus =");
    expect(tryAgent).toContain(
      "status.error || statusMissing || !status.data ? null : status.data",
    );
    expect(tryAgent).toContain(
      "const configured = verifiedAgentStatus\n    ? verifiedAgentStatus.configured\n    : false",
    );
    expect(tryAgent).toContain("onClick={() => void status.refetch()}");
    expect(tryAgent.indexOf("if (status.error || statusMissing)")).toBeLessThan(
      tryAgent.indexOf("if (!configured)"),
    );
    expect(tryAgent).not.toContain("status.data?.configured");
  });

  it("bounds onboarding practice basics before saving settings", () => {
    expect(PRACTICE_NAME_MAX_LENGTH).toBe(255);
    expect(practiceBasics).toContain('from "@/lib/settings-policy"');
    expect(practiceBasics).toContain(
      "trimmedName.length > 0 && trimmedName.length > PRACTICE_NAME_MAX_LENGTH",
    );
    expect(practiceBasics).toContain("if (practiceNameInvalid) return false");
    expect(practiceBasics).toContain("if (!country) return false");
    expect(practiceBasics).toContain(
      "practice.jurisdictionConfirmed && isClinicRegionCode(savedCountry)",
    );
    expect(practiceBasics).toContain('useState<ClinicRegionCode | "">("")');
    expect(practiceBasics).toContain('jurisdictionSource: "onboarding"');
    expect(practiceBasics).toContain(
      "setTimezone(regionDefaults(nextCountry).timezone)",
    );
    expect(practiceBasics).not.toContain('useState("US")');
    expect(practiceBasics).toContain("name: trimmedName");
    expect(practiceBasics).toContain("maxLength={PRACTICE_NAME_MAX_LENGTH}");
    expect(practiceBasics).toContain(
      "aria-invalid={practiceNameInvalid || undefined}",
    );
    expect(practiceBasics).toContain('id="ob-practice-name-error"');
    expect(practiceBasics).toContain(
      "Practice name must be at most {PRACTICE_NAME_MAX_LENGTH} characters.",
    );
  });

  it("bounds onboarding AI helper prompts with the shared agent policy", () => {
    expect(AGENT_INSTRUCTION_MAX_LENGTH).toBe(2000);
    expect(
      isAgentInstructionValid("Which pets are overdue for vaccines?"),
    ).toBe(true);
    expect(isAgentInstructionValid(" ".repeat(8))).toBe(false);

    expect(tryAgent).toContain('from "@/lib/agent/policy"');
    expect(tryAgent).toContain(
      "const canAsk = Boolean(\n    verifiedAgentStatus &&\n    configured &&\n    isAgentInstructionValid(question) &&\n    !run.isPending\n  )",
    );
    expect(tryAgent).toContain("if (!canAsk) return");
    expect(tryAgent).toContain("instruction: question.trim()");
    expect(tryAgent).toContain("maxLength={AGENT_INSTRUCTION_MAX_LENGTH}");
    expect(tryAgent).toContain("aria-invalid={questionInvalid || undefined}");
    expect(tryAgent).toContain("disabled={!canAsk}");
    expect(tryAgent).not.toContain(
      "disabled={!question.trim() || run.isPending}",
    );
  });

  it("bounds onboarding team invite emails before sending invites", () => {
    expect(SETTINGS_EMAIL_MAX_LENGTH).toBe(255);
    expect(inviteTeam).toContain('from "@/lib/settings-policy"');
    expect(inviteTeam).toContain("function getInviteEmailError");
    expect(inviteTeam).toContain("trimmed.length > SETTINGS_EMAIL_MAX_LENGTH");
    expect(inviteTeam).toContain(
      "const invalidRows = rows.filter((r) => getInviteEmailError(r.email));",
    );
    expect(inviteTeam).toContain("if (invalidRows.length > 0) {");
    expect(inviteTeam).toContain(
      "const toInvite = rows.filter((r) => isInviteEmailValid(r.email));",
    );
    expect(inviteTeam).toContain("email: row.email.trim().toLowerCase()");
    expect(inviteTeam).toContain("maxLength={SETTINGS_EMAIL_MAX_LENGTH}");
    expect(inviteTeam).toContain(
      "aria-invalid={Boolean(emailError) || undefined}",
    );
    expect(inviteTeam).toContain("id={emailErrorId}");
    expect(inviteTeam).not.toContain(
      "rows.filter((r) => isValidEmail(r.email))",
    );
  });
});
