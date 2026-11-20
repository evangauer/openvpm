import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  FUNNEL_EVENTS,
  trackCheckoutReturn,
  type CheckoutReturnPage,
} from "@/lib/funnel-analytics";

function capture(
  page: CheckoutReturnPage,
  params: { checkout: string | null; setup?: string | null },
) {
  const track = vi.fn();
  const fired = trackCheckoutReturn(page, params, track);
  return { fired, track };
}

describe("checkout return events", () => {
  it("fires checkout_succeeded on the signup login return", () => {
    const { fired, track } = capture("login", { checkout: "success" });

    expect(fired).toBe(true);
    expect(track).toHaveBeenCalledWith(FUNNEL_EVENTS.checkoutSucceeded, {
      source: "signup",
      path: "/login",
    });
  });

  it("fires checkout_cancelled on the signup login return", () => {
    const { fired, track } = capture("login", { checkout: "cancelled" });

    expect(fired).toBe(true);
    expect(track).toHaveBeenCalledWith(FUNNEL_EVENTS.checkoutCancelled, {
      source: "signup",
      path: "/login",
    });
  });

  it("fires checkout_succeeded on the settings billing return", () => {
    const { fired, track } = capture("settings_billing", {
      checkout: "success",
    });

    expect(fired).toBe(true);
    expect(track).toHaveBeenCalledWith(FUNNEL_EVENTS.checkoutSucceeded, {
      source: "settings",
      path: "/settings?tab=billing",
    });
  });

  it("fires checkout_cancelled on the settings billing return", () => {
    const { fired, track } = capture("settings_billing", {
      checkout: "cancelled",
    });

    expect(fired).toBe(true);
    expect(track).toHaveBeenCalledWith(FUNNEL_EVENTS.checkoutCancelled, {
      source: "settings",
      path: "/settings?tab=billing",
    });
  });

  it("fires checkout_succeeded when setup resumes from Checkout", () => {
    const { fired, track } = capture("setup_resume", {
      checkout: "success",
      setup: "resume",
    });

    expect(fired).toBe(true);
    expect(track).toHaveBeenCalledWith(FUNNEL_EVENTS.checkoutSucceeded, {
      source: "settings",
      path: "/?setup=resume",
    });
  });

  it("fires checkout_cancelled when setup resumes from a cancelled Checkout", () => {
    const { fired, track } = capture("setup_resume", {
      checkout: "cancelled",
      setup: "resume",
    });

    expect(fired).toBe(true);
    expect(track).toHaveBeenCalledWith(FUNNEL_EVENTS.checkoutCancelled, {
      source: "settings",
      path: "/?setup=resume",
    });
  });

  it("stays quiet for unrelated pages and unknown checkout values", () => {
    expect(
      capture("setup_resume", { checkout: "success", setup: null }).fired,
    ).toBe(false);
    expect(capture("login", { checkout: "pending" }).fired).toBe(false);
    expect(capture("settings_billing", { checkout: null }).fired).toBe(false);
    expect(capture("login", { checkout: "success" }).track).toHaveBeenCalledTimes(
      1,
    );
  });

  it("wires each return page to the shared event", () => {
    const login = readFileSync("app/(auth)/login/page.tsx", "utf8");
    const settings = readFileSync("app/(dashboard)/settings/page.tsx", "utf8");
    const setup = readFileSync(
      "components/onboarding/journey-overlay.tsx",
      "utf8",
    );

    expect(login).toContain(
      'useCheckoutReturnFunnelEvent("login", { checkout: checkoutState })',
    );
    expect(settings).toContain(
      'useCheckoutReturnFunnelEvent("settings_billing"',
    );
    expect(setup).toContain('trackCheckoutReturn(\n      "setup_resume"');
    expect(setup.indexOf("trackCheckoutReturn(")).toBeLessThan(
      setup.indexOf('params.get("setup") !== "resume"'),
    );
  });
});
