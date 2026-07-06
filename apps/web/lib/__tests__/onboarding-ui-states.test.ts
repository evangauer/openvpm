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
    "utf8"
  );
  const practiceBasics = readFileSync(
    "components/onboarding/steps/practice-basics.tsx",
    "utf8"
  );
  const branding = readFileSync(
    "components/onboarding/steps/branding.tsx",
    "utf8"
  );
  const tryAgent = readFileSync(
    "components/onboarding/steps/try-agent.tsx",
    "utf8"
  );
  const inviteTeam = readFileSync(
    "components/onboarding/steps/invite-team.tsx",
    "utf8"
  );
  const settingsRouter = readFileSync("server/routers/settings.ts", "utf8");

  it("surfaces onboarding page query failures before loading or fallback estimates", () => {
    expect(onboardingPage).toContain("function OnboardingLoadError");
    expect(onboardingPage).toContain(
      "const loadError = status.error ?? subscription.error"
    );
    expect(onboardingPage).toContain("Onboarding details could not load");
    expect(onboardingPage).toContain("status.refetch()");
    expect(onboardingPage).toContain("subscription.refetch()");
    expect(onboardingPage.indexOf("if (loadError)")).toBeLessThan(
      onboardingPage.indexOf("if (status.isLoading || subscription.isLoading)")
    );
    expect(onboardingPage).toContain("if (!status.data || !subscription.data)");
    expect(onboardingPage).toContain(
      "Onboarding details were unavailable. Retry before reviewing trial, billing, or demo-data setup."
    );
    expect(onboardingPage).toContain("const onboardingStatus = status.data");
    expect(onboardingPage).toContain("const subscriptionDetails = subscription.data");
    expect(onboardingPage.indexOf("if (status.isLoading || subscription.isLoading)")).toBeLessThan(
      onboardingPage.indexOf("if (!status.data || !subscription.data)")
    );
    expect(onboardingPage.indexOf("if (!status.data || !subscription.data)")).toBeLessThan(
      onboardingPage.indexOf("const subscriptionDetails = subscription.data")
    );
    expect(onboardingPage).not.toContain("subscription.data?.locationCount ?? 1");
    expect(onboardingPage).not.toContain("subscription.data?.billableSeatCount ?? 1");
    expect(onboardingPage).not.toContain("subscription.data?.estimatedMonthlyBase");
    expect(onboardingPage).not.toContain("status.data?.hasDemoData");
  });

  it("guards direct onboarding actions to admin users", () => {
    expect(onboardingPage).toContain('import { useSession } from "next-auth/react"');
    expect(onboardingPage).toContain(
      'import { EmptyState } from "@/components/common/empty-state"'
    );
    expect(onboardingPage).toContain("export default function OnboardingPage()");
    expect(onboardingPage).toContain("function AdminOnboardingPage()");
    expect(onboardingPage).toContain(
      "const { data: session, status: sessionStatus } = useSession()"
    );
    expect(onboardingPage).toContain('if (sessionStatus === "loading")');
    expect(onboardingPage).toContain('if (session?.user?.role !== "admin")');
    expect(onboardingPage).toContain('title="Onboarding is admin-only"');
    expect(onboardingPage).toContain(
      'description="Only admins can change setup, billing, team, and demo data."'
    );
    expect(onboardingPage).toContain("return <AdminOnboardingPage />");

    expect(settingsRouter).toContain("onboardingStatus: adminProcedure.query");
    expect(settingsRouter).toContain("completeOnboarding: adminProcedure.mutation");
    expect(settingsRouter).toContain("clearDemoData: adminProcedure.mutation");
  });

  it("counts onboarding trial days from the practice timezone", () => {
    expect(onboardingPage).toContain(
      'import { trialCalendarDaysLeft } from "@/lib/billing/trial-days"'
    );
    expect(onboardingPage).toContain(
      "subscriptionDetails.trialEndsAt,\n    subscriptionDetails.timezone"
    );
    expect(onboardingPage).not.toContain("trialEndsAt.getTime() - Date.now()");
  });

  it("surfaces guided setup query failures instead of showing default step states", () => {
    expect(practiceBasics).toContain("function OnboardingStepError");
    expect(practiceBasics).toContain("Practice details could not load");
    expect(practiceBasics).toContain("onRetry={() => void refetch()}");
    expect(practiceBasics).toContain("if (error || isLoading) return false;");
    expect(practiceBasics.indexOf("if (error)")).toBeLessThan(
      practiceBasics.indexOf("if (isLoading)")
    );
    expect(
      practiceBasics.indexOf("if (error || isLoading) return false;")
    ).toBeLessThan(
      practiceBasics.indexOf("if (practiceNameInvalid) return false")
    );

    expect(branding).toContain("error: practiceError");
    expect(branding).toContain("Saved branding could not load");
    expect(branding).toContain("onClick={() => void refetchPractice()}");
    expect(branding.indexOf("{practiceError ? (")).toBeLessThan(
      branding.indexOf("{currentLogo ? (")
    );

    expect(tryAgent).toContain("AI helper status could not load");
    expect(tryAgent).toContain("AI helper status is unavailable");
    expect(tryAgent).toContain(
      "AI helper configuration could not be verified. Please retry before asking the helper."
    );
    expect(tryAgent).toContain("const verifiedAgentStatus =");
    expect(tryAgent).toContain(
      "status.error || statusMissing || !status.data ? null : status.data"
    );
    expect(tryAgent).toContain(
      "const configured = verifiedAgentStatus\n    ? verifiedAgentStatus.configured\n    : false"
    );
    expect(tryAgent).toContain("onClick={() => void status.refetch()}");
    expect(tryAgent.indexOf("if (status.error || statusMissing)")).toBeLessThan(
      tryAgent.indexOf("if (!configured)")
    );
    expect(tryAgent).not.toContain("status.data?.configured");
  });

  it("bounds onboarding practice basics before saving settings", () => {
    expect(PRACTICE_NAME_MAX_LENGTH).toBe(255);
    expect(practiceBasics).toContain('from "@/lib/settings-policy"');
    expect(practiceBasics).toContain(
      "trimmedName.length > 0 && trimmedName.length > PRACTICE_NAME_MAX_LENGTH"
    );
    expect(practiceBasics).toContain("if (practiceNameInvalid) return false");
    expect(practiceBasics).toContain("name: trimmedName");
    expect(practiceBasics).toContain("maxLength={PRACTICE_NAME_MAX_LENGTH}");
    expect(practiceBasics).toContain(
      "aria-invalid={practiceNameInvalid || undefined}"
    );
    expect(practiceBasics).toContain('id="ob-practice-name-error"');
    expect(practiceBasics).toContain(
      "Practice name must be at most {PRACTICE_NAME_MAX_LENGTH} characters."
    );
  });

  it("bounds onboarding AI helper prompts with the shared agent policy", () => {
    expect(AGENT_INSTRUCTION_MAX_LENGTH).toBe(2000);
    expect(isAgentInstructionValid("Which pets are overdue for vaccines?")).toBe(
      true
    );
    expect(isAgentInstructionValid(" ".repeat(8))).toBe(false);

    expect(tryAgent).toContain('from "@/lib/agent/policy"');
    expect(tryAgent).toContain(
      "const canAsk = Boolean(\n    verifiedAgentStatus &&\n    configured &&\n    isAgentInstructionValid(question) &&\n    !run.isPending\n  )"
    );
    expect(tryAgent).toContain("if (!canAsk) return");
    expect(tryAgent).toContain("instruction: question.trim()");
    expect(tryAgent).toContain("maxLength={AGENT_INSTRUCTION_MAX_LENGTH}");
    expect(tryAgent).toContain("aria-invalid={questionInvalid || undefined}");
    expect(tryAgent).toContain("disabled={!canAsk}");
    expect(tryAgent).not.toContain(
      "disabled={!question.trim() || run.isPending}"
    );
  });

  it("bounds onboarding team invite emails before sending invites", () => {
    expect(SETTINGS_EMAIL_MAX_LENGTH).toBe(255);
    expect(inviteTeam).toContain('from "@/lib/settings-policy"');
    expect(inviteTeam).toContain("function getInviteEmailError");
    expect(inviteTeam).toContain(
      "trimmed.length > SETTINGS_EMAIL_MAX_LENGTH"
    );
    expect(inviteTeam).toContain(
      "const invalidRows = rows.filter((r) => getInviteEmailError(r.email));"
    );
    expect(inviteTeam).toContain("if (invalidRows.length > 0) {");
    expect(inviteTeam).toContain(
      "const toInvite = rows.filter((r) => isInviteEmailValid(r.email));"
    );
    expect(inviteTeam).toContain("email: row.email.trim().toLowerCase()");
    expect(inviteTeam).toContain("maxLength={SETTINGS_EMAIL_MAX_LENGTH}");
    expect(inviteTeam).toContain(
      "aria-invalid={Boolean(emailError) || undefined}"
    );
    expect(inviteTeam).toContain("id={emailErrorId}");
    expect(inviteTeam).not.toContain(
      "rows.filter((r) => isValidEmail(r.email))"
    );
  });
});
