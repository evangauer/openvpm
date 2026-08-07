import { describe, expect, it } from "vitest";
import {
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
      "https://app.openvpm.com/register?intent=cloud&source=demo&utm_source=demo&utm_medium=product&utm_campaign=demo_login"
    );
  });

  it("carries the anonymous visitor id into registration", () => {
    const url = buildCloudSignupUrl({
      visitorId: "123E4567-E89B-42D3-A456-426614174000",
    });
    const params = new URLSearchParams(url.slice("/register?".length));
    expect(params.get("funnel_id")).toBe(
      "123e4567-e89b-42d3-a456-426614174000"
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

describe("FUNNEL_EVENTS", () => {
  it("keeps stable event name contracts", () => {
    expect(FUNNEL_EVENTS.demoLand).toBe("demo_land");
    expect(FUNNEL_EVENTS.demoGateViewed).toBe("demo_gate_viewed");
    expect(FUNNEL_EVENTS.demoGateSubmitted).toBe("demo_gate_submitted");
    expect(FUNNEL_EVENTS.demoRoleSelected).toBe("demo_role_selected");
    expect(FUNNEL_EVENTS.demoToolOpened).toBe("demo_tool_opened");
    expect(FUNNEL_EVENTS.demoCtaStartClinic).toBe("demo_cta_start_clinic");
    expect(FUNNEL_EVENTS.signupLand).toBe("signup_land");
  });
});
