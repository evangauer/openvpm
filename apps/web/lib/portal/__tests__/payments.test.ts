import { describe, expect, it } from "vitest";
import {
  buildPortalPaymentReturnUrl,
  isSafePortalCheckoutRedirectUrl,
  portalPaymentBanner,
} from "../payments";

describe("portal payment helpers", () => {
  it("builds Stripe return URLs back to the portal invoice list", () => {
    const invoiceId = "00000000-0000-0000-0000-000000000001";

    expect(
      buildPortalPaymentReturnUrl({
        origin: "https://app.example.com/",
        status: "success",
        invoiceId,
      })
    ).toBe(
      `https://app.example.com/portal/invoices?payment=success&invoice=${invoiceId}`
    );

    expect(
      buildPortalPaymentReturnUrl({
        origin: "https://app.example.com",
        status: "cancelled",
      })
    ).toBe("https://app.example.com/portal/invoices?payment=cancelled");
  });

  it("maps known payment statuses to client-facing banners", () => {
    expect(portalPaymentBanner("success")).toMatchObject({ kind: "success" });
    expect(
      portalPaymentBanner(
        "success",
        "00000000-0000-0000-0000-000000000001"
      )?.message
    ).toContain("selected invoice");
    expect(portalPaymentBanner("cancelled")).toMatchObject({ kind: "info" });
    expect(portalPaymentBanner("unknown")).toBeNull();
    expect(portalPaymentBanner(null)).toBeNull();
  });

  it("only accepts safe HTTPS checkout redirect URLs", () => {
    expect(
      isSafePortalCheckoutRedirectUrl("https://checkout.stripe.com/c/pay_123")
    ).toBe(true);
    expect(
      isSafePortalCheckoutRedirectUrl("https://billing.stripe.com/session")
    ).toBe(true);

    expect(isSafePortalCheckoutRedirectUrl("http://checkout.stripe.com")).toBe(
      false
    );
    expect(isSafePortalCheckoutRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafePortalCheckoutRedirectUrl(" https://checkout.stripe.com")).toBe(
      false
    );
    expect(
      isSafePortalCheckoutRedirectUrl("https://user:pass@checkout.stripe.com")
    ).toBe(false);
    expect(
      isSafePortalCheckoutRedirectUrl("https://stripe.example/session")
    ).toBe(false);
    expect(
      isSafePortalCheckoutRedirectUrl(
        "https://checkout.stripe.com.example.org/session"
      )
    ).toBe(false);
    expect(isSafePortalCheckoutRedirectUrl("not a url")).toBe(false);
    expect(isSafePortalCheckoutRedirectUrl(null)).toBe(false);
  });
});
