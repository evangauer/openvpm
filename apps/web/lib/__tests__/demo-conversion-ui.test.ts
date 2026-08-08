import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("demo conversion bridge UI", () => {
  const login = readFileSync("app/(auth)/login/page.tsx", "utf8");
  const demoAccessRoute = readFileSync("app/api/demo-access/route.ts", "utf8");
  const register = readFileSync("app/(auth)/register/page.tsx", "utf8");
  const layout = readFileSync("app/(dashboard)/layout.tsx", "utf8");
  const bar = readFileSync("components/demo/demo-conversion-bar.tsx", "utf8");
  const tracker = readFileSync(
    "components/demo/demo-funnel-tracker.tsx",
    "utf8"
  );

  it("instruments the email gate and start-clinic CTA", () => {
    expect(login).toContain("FUNNEL_EVENTS.demoLand");
    expect(login).toContain("FUNNEL_EVENTS.demoGateViewed");
    expect(login).toContain("anonymousId: visitorId ?? getFunnelVisitorId()");
    expect(login).not.toContain(
      "trackFunnelEvent(FUNNEL_EVENTS.demoGateSubmitted)"
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

  it("mounts the demo bar and path tracker in the dashboard shell", () => {
    expect(layout).toContain("DemoConversionBar");
    expect(layout).toContain("DemoFunnelTracker");
    expect(bar).toContain("Start my clinic");
    expect(bar).toContain("buildCloudSignupUrl");
    expect(tracker).toContain("FUNNEL_EVENTS.demoToolOpened");
  });
});
