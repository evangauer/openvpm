import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public capability claims", () => {
  it("keeps the README aligned with clinic-pilot boundaries", () => {
    const source = readFileSync("../../README.md", "utf8");

    expect(source).toContain("Clinic Pilot Readiness Guide");
    expect(source).toContain("controlled, one-location clinic pilot");
    expect(source).toContain(
      "General-purpose bulk marketing campaigns are not included",
    );
    expect(source).toContain("Next.js 15");
    expect(source).toContain("React 19");
    expect(source).toContain(
      "dashboard router coverage does not imply equivalent public REST coverage",
    );
    expect(source).not.toContain("Real-time practice whiteboard");
    expect(source).not.toContain("Self-service online booking (client portal)");
    expect(source).not.toContain(
      "point an existing integration at OpenVPM with zero changes",
    );
    expect(source).not.toContain("Costs go to zero");
    expect(source).not.toContain("apps/www");
  });

  it("separates shipped workflows from configured and pilot services", () => {
    const source = readFileSync("../../ROADMAP.md", "utf8");

    expect(source).toContain("Configuration-dependent / controlled pilot");
    expect(source).toContain("clinic staff confirm the final time");
    expect(source).toContain("complete Stripe Connect onboarding");
    expect(source).toContain("carrier-approved registration");
    expect(source).toContain("manually entered or in-house lab results");
    expect(source).not.toContain("client portal, real-time whiteboard");
    expect(source).not.toContain("Self-service online booking");
    expect(source).not.toContain(
      "Payments (Stripe) — online invoice payment + wellness-plan charge capture",
    );
    expect(source).not.toContain(
      "SMS / email delivery (Twilio / Resend) for reminders and two-way client comms",
    );
  });
});
