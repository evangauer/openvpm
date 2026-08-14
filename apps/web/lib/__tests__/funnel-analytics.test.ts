import { describe, expect, it } from "vitest";
import { acquisitionFromSearchParams } from "@/lib/acquisition";
import {
  buildClinicFitDemoUrl,
  buildClinicFitSignupUrl,
  buildCloudSignupUrl,
  FUNNEL_EVENTS,
  funnelToolFromPath,
} from "@/lib/funnel-analytics";

describe("funnelToolFromPath", () => {
  it("maps primary demo surfaces to stable tool ids", () => {
    expect(funnelToolFromPath("/agent")).toBe("ask_ai");
    expect(funnelToolFromPath("/agent?q=1")).toBe("ask_ai");
    expect(funnelToolFromPath("/schedule")).toBe("day_board");
    expect(funnelToolFromPath("/whiteboard")).toBe("whiteboard");
    expect(funnelToolFromPath("/patients/abc")).toBe("patients");
    expect(funnelToolFromPath("/billing/new")).toBe("billing");
    expect(funnelToolFromPath("/")).toBe("dashboard");
  });

  it("falls back to other for unknown paths", () => {
    expect(funnelToolFromPath("/api-docs")).toBe("other");
  });
});

describe("buildCloudSignupUrl", () => {
  it("builds a relative register URL with acquisition params", () => {
    const url = buildCloudSignupUrl({ tool: "ask_ai" });
    expect(url.startsWith("/register?")).toBe(true);
    const params = new URLSearchParams(url.slice("/register?".length));
    expect(params.get("intent")).toBe("cloud");
    expect(params.get("source")).toBe("demo");
    expect(params.get("utm_source")).toBe("demo");
    expect(params.get("utm_medium")).toBe("product");
    expect(params.get("utm_campaign")).toBe("demo_ask_ai");
  });

  it("prefixes an absolute app origin when provided", () => {
    const url = buildCloudSignupUrl({
      appOrigin: "https://app.openvpm.com/",
      campaign: "demo_login",
    });
    expect(url).toBe(
      "https://app.openvpm.com/register?intent=cloud&source=demo&utm_source=demo&utm_medium=product&utm_campaign=demo_login",
    );
  });

  it("carries the anonymous visitor id into registration", () => {
    const url = buildCloudSignupUrl({
      visitorId: "123E4567-E89B-42D3-A456-426614174000",
    });
    const params = new URLSearchParams(url.slice("/register?".length));
    expect(params.get("funnel_id")).toBe(
      "123e4567-e89b-42d3-a456-426614174000",
    );
  });

  it("falls back to relative path when origin is invalid", () => {
    const url = buildCloudSignupUrl({
      appOrigin: "not a url",
      source: "demo",
    });
    expect(url.startsWith("/register?")).toBe(true);
  });
});

describe("buildClinicFitSignupUrl", () => {
  it("preserves validated attribution across clinic fit and registration", () => {
    const url = buildClinicFitSignupUrl(
      new URLSearchParams({
        source: "homepage_pricing",
        funnel_id: "123E4567-E89B-42D3-A456-426614174000",
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "clinic_launch-2026",
      }),
    );
    const params = new URL(url, "https://app.openvpm.com").searchParams;

    expect(url.startsWith("/register?")).toBe(true);
    expect(Object.fromEntries(params)).toEqual({
      intent: "cloud",
      source: "homepage_pricing",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "clinic_launch-2026",
      funnel_id: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(acquisitionFromSearchParams(params)).toEqual({
      source: "homepage_pricing",
      medium: "cpc",
      campaign: "clinic_launch-2026",
      funnelId: "123e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("uses clinic fit as the source fallback and rejects unsafe input", () => {
    const url = buildClinicFitSignupUrl(
      new URLSearchParams({
        source: "doctor@example.com",
        funnel_id: "not-a-uuid",
        utm_campaign: "contains spaces",
        utm_term: "patient-name",
        email: "doctor@example.com",
        next: "https://attacker.example",
        redirect: "/dashboard",
      }),
    );
    const params = new URL(url, "https://app.openvpm.com").searchParams;

    expect(Object.fromEntries(params)).toEqual({
      intent: "cloud",
      source: "clinic_fit",
    });
    expect(url).not.toContain("doctor");
    expect(url).not.toContain("attacker");
    expect(url).not.toContain("patient-name");
  });

  it("preserves the same safe attribution when clinic fit opens the demo", () => {
    const url = new URL(
      buildClinicFitDemoUrl(
        new URLSearchParams({
          source: "homepage_pricing",
          funnel_id: "123E4567-E89B-42D3-A456-426614174000",
          utm_campaign: "clinic_launch-2026",
          email: "doctor@example.com",
          next: "https://attacker.example",
        }),
      ),
    );

    expect(`${url.origin}${url.pathname}`).toBe(
      "https://demo.openvpm.com/login",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: "homepage_pricing",
      utm_campaign: "clinic_launch-2026",
      funnel_id: "123e4567-e89b-42d3-a456-426614174000",
    });
  });
});

describe("FUNNEL_EVENTS", () => {
  it("keeps stable event name contracts", () => {
    expect(FUNNEL_EVENTS.demoLand).toBe("demo_land");
    expect(FUNNEL_EVENTS.demoGateViewed).toBe("demo_gate_viewed");
    expect(FUNNEL_EVENTS.demoGateSubmitted).toBe("demo_gate_submitted");
    expect(FUNNEL_EVENTS.demoRoleSelected).toBe("demo_role_selected");
    expect(FUNNEL_EVENTS.demoToolOpened).toBe("demo_tool_opened");
    expect(FUNNEL_EVENTS.demoCtaStartClinic).toBe("demo_cta_start_clinic");
    expect(FUNNEL_EVENTS.signupLand).toBe("signup_land");
    expect(FUNNEL_EVENTS.signupProfileViewed).toBe("signup_profile_viewed");
    expect(FUNNEL_EVENTS.signupProfileCompleted).toBe(
      "signup_profile_completed",
    );
    expect(FUNNEL_EVENTS.signupAccountViewed).toBe("signup_account_viewed");
    expect(FUNNEL_EVENTS.signupSubmitted).toBe("signup_submitted");
    expect(FUNNEL_EVENTS.signupSucceeded).toBe("signup_succeeded");
    expect(FUNNEL_EVENTS.onboardingModelSelected).toBe(
      "onboarding_model_selected",
    );
    expect(FUNNEL_EVENTS.onboardingGoalSelected).toBe(
      "onboarding_goal_selected",
    );
    expect(FUNNEL_EVENTS.onboardingPlanBuilt).toBe("onboarding_plan_built");
    expect(FUNNEL_EVENTS.onboardingStepViewed).toBe("onboarding_step_viewed");
    expect(FUNNEL_EVENTS.onboardingStepCompleted).toBe(
      "onboarding_step_completed",
    );
    expect(FUNNEL_EVENTS.onboardingCompleted).toBe("onboarding_completed");
    expect(FUNNEL_EVENTS.firstActionSelected).toBe("first_action_selected");
  });
});
