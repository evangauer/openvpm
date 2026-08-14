import { describe, expect, it } from "vitest";
import { isSafeCheckoutRedirectUrl } from "../checkout-redirect";

describe("checkout redirect URL safety", () => {
  it("accepts HTTPS checkout URLs without embedded credentials", () => {
    expect(
      isSafeCheckoutRedirectUrl("https://checkout.stripe.com/c/pay_123")
    ).toBe(true);
    expect(isSafeCheckoutRedirectUrl("https://billing.stripe.com/session")).toBe(
      true
    );
  });

  it("rejects malformed or dangerous checkout redirect URLs", () => {
    expect(isSafeCheckoutRedirectUrl("http://checkout.stripe.com")).toBe(false);
    expect(isSafeCheckoutRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeCheckoutRedirectUrl(" https://checkout.stripe.com")).toBe(
      false
    );
    expect(isSafeCheckoutRedirectUrl("https://checkout.stripe.com\n")).toBe(
      false
    );
    expect(
      isSafeCheckoutRedirectUrl("https://user:pass@checkout.stripe.com")
    ).toBe(false);
    expect(isSafeCheckoutRedirectUrl("https://stripe.example/session")).toBe(
      false
    );
    expect(
      isSafeCheckoutRedirectUrl(
        "https://checkout.stripe.com.example.org/session"
      )
    ).toBe(false);
    expect(
      isSafeCheckoutRedirectUrl("https://evil.example/stripe.com/session")
    ).toBe(false);
    expect(isSafeCheckoutRedirectUrl("not a url")).toBe(false);
    expect(isSafeCheckoutRedirectUrl(null)).toBe(false);
  });
});
