import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("signup billing copy", () => {
  const registerSource = readFileSync("app/(auth)/register/page.tsx", "utf8");
  // The dormant WelcomePanel was replaced by the welcome surface; its copy
  // deck is now the customer-facing first-run voice to hold to account.
  const welcomeCopySource = readFileSync(
    "components/welcome/welcome-copy.ts",
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

  it("advertises the hosted trial as no-card, not card-collected", () => {
    const noCardSurfaces = [
      registerSource,
      welcomeCopySource,
      welcomeEmailSource,
      readmeSource,
    ];
    // None of the customer-facing trial surfaces should still claim a card is
    // collected up front — the hosted trial is card-free.
    for (const source of noCardSurfaces) {
      expect(source).not.toContain("collect a card securely");
      expect(source).not.toContain("After secure Stripe checkout");
      expect(source).not.toContain("card-collected trial");
      expect(source).not.toContain("billing secured through Stripe");
    }
    expect(registerSource).toContain("No credit card required");
    expect(welcomeEmailSource).toContain("no credit card");
    expect(readmeSource).toContain("no credit card required");
    expect(activationChecklistSource).toContain("Confirm billing is connected");
  });

  it("keeps the safe card-checkout path for conversion", () => {
    // The card checkout (used to convert/upgrade) is still guarded by the safe
    // redirect helper even though signup no longer forces it.
    expect(registerSource).toContain(
      'import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect"'
    );
    expect(registerSource).toContain("data.checkoutUrl");
    expect(registerSource).toContain(
      "if (!isSafeCheckoutRedirectUrl(data.checkoutUrl))"
    );
    // New signups land on their validated destination via a FULL document navigation: the
    // logo link prefetches "/" while logged out, so the router cache holds a
    // redirect to /login and router.push would bounce fresh accounts there.
    expect(registerSource).toContain("window.location.assign(nextPath)");
    expect(registerSource).toContain("safeAuthNextPath");
    expect(registerSource).not.toContain('router.push("/");');
  });
});
