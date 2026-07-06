import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("signup billing copy", () => {
  const registerSource = readFileSync("app/(auth)/register/page.tsx", "utf8");
  const welcomePanelSource = readFileSync(
    "components/dashboard/welcome-panel.tsx",
    "utf8"
  );
  const onboardingSource = readFileSync(
    "app/(dashboard)/onboarding/page.tsx",
    "utf8"
  );
  const activationChecklistSource = readFileSync(
    "components/dashboard/activation-checklist.tsx",
    "utf8"
  );
  const welcomeEmailSource = readFileSync(
    "../../packages/email/src/templates/WelcomeEmail.tsx",
    "utf8"
  );
  const readmeSource = readFileSync("../../README.md", "utf8");
  const hostedRunbookSource = readFileSync(
    "../../docs/hosted-cloud-production.md",
    "utf8"
  );
  const hostedTrialSources = [
    registerSource,
    welcomePanelSource,
    onboardingSource,
    activationChecklistSource,
    welcomeEmailSource,
    readmeSource,
    hostedRunbookSource,
  ];

  it("does not advertise hosted Cloud trials as no-card signups", () => {
    for (const source of hostedTrialSources) {
      expect(source).not.toMatch(/no[- ]card/i);
      expect(source).not.toContain("Add a card before your trial ends");
    }
    expect(registerSource).toContain(
      "Hosted Cloud trials collect a card securely with Stripe."
    );
    expect(readmeSource).toContain("14-day card-collected trial");
    expect(hostedRunbookSource).toContain("card-collected trial");
    expect(welcomeEmailSource).toContain("After secure Stripe checkout");
    expect(welcomePanelSource).toContain("billing secured through Stripe");
    expect(onboardingSource).toContain("Setup before first charge");
    expect(activationChecklistSource).toContain("Confirm billing is connected");
    expect(registerSource).toContain(
      'import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect"'
    );
    expect(registerSource).toContain("data.checkoutUrl");
    expect(registerSource).toContain(
      "if (!isSafeCheckoutRedirectUrl(data.checkoutUrl))"
    );
  });
});
