import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudOfferContext } from "@/components/onboarding/cloud-offer-context";

const offer = {
  hostedBilling: true,
  cardRequired: true,
  trialDays: 14,
  monthlyPriceUsd: 79,
};

describe("Cloud offer context", () => {
  it("discloses the card-required trial, renewal and pilot terms", () => {
    const html = renderToStaticMarkup(createElement(CloudOfferContext, offer));
    expect(html).toContain("14-day free trial");
    expect(html).toContain("Card required; no subscription charge today");
    expect(html).toContain(
      "billing starts automatically at $79 USD/month per active location",
    );
    expect(html).toContain("applicable taxes and usage overages");
    expect(html).toContain("unless you cancel before the trial ends");
    expect(html).toContain("guided pilot");
    expect(html).toContain('href="https://openvpm.com/pricing"');
    expect(html).toContain('href="/legal/terms"');
  });

  it("does not describe automatic billing for a no-card trial", () => {
    const html = renderToStaticMarkup(
      createElement(CloudOfferContext, { ...offer, cardRequired: false }),
    );
    expect(html).toContain("No card required to start");
    expect(html).not.toContain("billing starts automatically");
  });

  it("uses the offer supplied by the deployment instead of hardcoded terms", () => {
    const html = renderToStaticMarkup(
      createElement(CloudOfferContext, {
        ...offer,
        trialDays: 21,
        monthlyPriceUsd: 99,
      }),
    );
    expect(html).toContain("21-day free trial");
    expect(html).toContain("$99 USD/month per active location");
    expect(html).not.toContain("14-day");
    expect(html).not.toContain("$79");
  });

  it("does not show Cloud terms on a self-hosted deployment", () => {
    expect(
      renderToStaticMarkup(
        createElement(CloudOfferContext, {
          ...offer,
          hostedBilling: false,
          cardRequired: false,
        }),
      ),
    ).toBe("");
  });
});
