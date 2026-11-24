import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("demo conversion bridge UI", () => {
  const login = readFileSync("components/demo/demo-login.tsx", "utf8");
  const demoAccessRoute = readFileSync("app/api/demo-access/route.ts", "utf8");
  const register = readFileSync("app/(auth)/register/register-form.tsx", "utf8");
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
    expect(login).toContain("Enter the demo");
    expect(login).not.toContain("password123");
    expect(login).not.toContain("View raw credentials");
    expect(login).toContain("DEMO_ROLE_OPTIONS");
    expect(login).toContain("role: role.id");
    expect(login).toContain("Start my clinic");
  });

  it("tracks signup land with acquisition context", () => {
    expect(register).toContain("FUNNEL_EVENTS.signupLand");
    expect(register).toContain("acquisition?.source");
    expect(register).toContain("acquisitionWithFunnelVisitorId");
    expect(register).toContain("getFunnelVisitorId()");
    expect(register).toContain("acquisition: registrationAcquisition");
  });

  it("asks for four account fields, then the trial summary, before Checkout", () => {
    expect(register).toContain("Create your clinic workspace.");
    expect(register).toContain('type RegistrationStage = "details" | "review"');
    expect(register).toContain("Step 1 of 2");
    expect(register).toContain("Step 2 of 2");
    expect(register).not.toContain("Step 1 of 4");
    expect(register).not.toContain("<ClinicIntentBuilder");
    expect(register).not.toContain("onboardingDraft:");
    expect(register).toContain('label="Practice name"');
    expect(register).toContain('label="Work email"');
    expect(register).toContain('label="Password"');
    expect(register).toContain('label="Clinic country"');
    expect(register).toContain("checkoutTrialSummary(");
    expect(register).toContain("Continue to secure checkout");
    expect(register).toContain("Confirm your trial, then checkout.");
    expect(register).toContain("FUNNEL_EVENTS.signupLand");
    expect(register).toContain("FUNNEL_EVENTS.signupAccountViewed");
    expect(register).toContain("FUNNEL_EVENTS.signupSubmitted");
    expect(register).toContain("FUNNEL_EVENTS.signupSucceeded");
    expect(register).toContain('await signIn("credentials"');
    expect(firstDayRecommendations).toContain("FIRST_GOAL_RECOMMENDATIONS");
    expect(firstDayRecommendations).toContain("Plan a safe first import");
    expect(firstDayRecommendations).toContain("Explore a ready-made clinic");
    expect(firstDayRecommendations).toContain("Review the self-hosted path");
  });

  it("mounts the demo bar and path tracker in the dashboard shell", () => {
    expect(layout).toContain("DemoConversionBar");
    expect(layout).toContain("DemoFunnelTracker");
    expect(bar).toContain("Start my clinic");
    expect(bar).toContain("buildCloudSignupUrl");
    expect(tracker).toContain("FUNNEL_EVENTS.demoToolOpened");
  });
});
