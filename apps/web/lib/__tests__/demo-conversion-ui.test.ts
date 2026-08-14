import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("demo conversion bridge UI", () => {
  const login = readFileSync("app/(auth)/login/page.tsx", "utf8");
  const demoAccessRoute = readFileSync("app/api/demo-access/route.ts", "utf8");
  const register = readFileSync("app/(auth)/register/page.tsx", "utf8");
  const firstDayRecommendations = readFileSync(
    "components/onboarding/first-day-recommendations.tsx",
    "utf8",
  );
  const layout = readFileSync("app/(dashboard)/layout.tsx", "utf8");
  const bar = readFileSync("components/demo/demo-conversion-bar.tsx", "utf8");
  const tracker = readFileSync(
    "components/demo/demo-funnel-tracker.tsx",
    "utf8",
  );

  it("instruments the email gate and start-clinic CTA", () => {
    expect(login).toContain("FUNNEL_EVENTS.demoLand");
    expect(login).toContain("FUNNEL_EVENTS.demoGateViewed");
    expect(login).toContain("anonymousId: visitorId ?? getFunnelVisitorId()");
    expect(login).not.toContain(
      "trackFunnelEvent(FUNNEL_EVENTS.demoGateSubmitted)",
    );
    expect(demoAccessRoute).toContain('name: "demo_gate_submitted"');
    expect(demoAccessRoute).toContain("await recordAcceptedDemoGate");
    expect(login).toContain("FUNNEL_EVENTS.demoCtaStartClinic");
    expect(login).toContain("buildCloudSignupUrl");
    expect(login).toContain("Open the live demo");
    expect(login).not.toContain("password123");
    expect(login).not.toContain("View raw credentials");
    expect(login.match(/min-h-11/g)?.length).toBeGreaterThanOrEqual(2);
    expect(login).toContain("Start my clinic");
  });

  it("tracks signup land with acquisition context", () => {
    expect(register).toContain("FUNNEL_EVENTS.signupLand");
    expect(register).toContain("acquisition?.source");
    expect(register).toContain("acquisitionWithFunnelVisitorId");
    expect(register).toContain("getFunnelVisitorId()");
    expect(register).toContain("acquisition: registrationAcquisition");
  });

  it("reveals a useful first day before asking for account security", () => {
    expect(register).toContain("A platform truly built for your clinic.");
    expect(register).toContain("<ClinicIntentBuilder");
    expect(register).toContain(
      'type RegistrationStage = "profile" | "workflow" | "preview" | "account"',
    );
    expect(register).toContain("Step 1 of 4");
    expect(register).toContain("Step 2 of 4");
    expect(register).toContain("Step 3 of 4");
    expect(register).toContain("Step 4 of 4");
    expect(register).toContain("What would you like to see?");
    expect(register).toContain(
      "Here are some useful workflows for your practice.",
    );
    expect(register).toContain('label="Practice name"');
    expect(register).toContain('label="Work email"');
    expect(register).toContain("See my first day");
    expect(register).toContain("Your first day is ready.");
    expect(register).toContain(
      "<FirstDayRecommendations primaryGoal={firstGoal} />",
    );
    expect(register).toContain("Secure my workspace");
    expect(register).toContain("Secure your workspace.");
    expect(register.indexOf("Your first day is ready.")).toBeLessThan(
      register.indexOf("Secure your workspace."),
    );
    expect(firstDayRecommendations).toContain("FIRST_GOAL_RECOMMENDATIONS");
    expect(firstDayRecommendations).toContain("Plan a safe first import");
    expect(firstDayRecommendations).toContain("Explore a ready-made clinic");
    expect(firstDayRecommendations).toContain("Review the self-hosted path");
    expect(register).toContain('label="Password"');
    expect(register).not.toContain(
      "Two quick choices make the rest of setup feel like your clinic—not a generic software tour.",
    );
    expect(register).toContain("REGISTRATION_PROFILE_STORAGE_KEY");
    expect(register).toContain('setStage("workflow")');
    expect(register).toContain(
      "Practice name and email intentionally stay out of sessionStorage.",
    );
    expect(register).toContain("if (!profileRestored) return;");
    expect(register).toContain("setProfileRestored(true)");
    expect(register).toContain("onboardingDraft: { clinicModel, firstGoal }");
    expect(register).toContain("FUNNEL_EVENTS.signupProfileCompleted");
    expect(register).toContain("FUNNEL_EVENTS.signupSubmitted");
    expect(register).toContain("FUNNEL_EVENTS.signupSucceeded");
    expect(register).toContain(
      "No patient or client information belongs here.",
    );
  });

  it("mounts the demo bar and path tracker in the dashboard shell", () => {
    expect(layout).toContain("DemoConversionBar");
    expect(layout).toContain("DemoFunnelTracker");
    expect(bar).toContain("Start my clinic");
    expect(bar).toContain("buildCloudSignupUrl");
    expect(tracker).toContain("FUNNEL_EVENTS.demoToolOpened");
  });
});
