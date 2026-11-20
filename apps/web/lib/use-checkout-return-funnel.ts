"use client";

import { useEffect, useRef } from "react";
import {
  trackCheckoutReturn,
  type CheckoutReturnPage,
} from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";

/**
 * Record checkout_succeeded or checkout_cancelled once per mount when this
 * page is a Stripe Checkout return. Analytics never blocks the page.
 */
export function useCheckoutReturnFunnelEvent(
  page: CheckoutReturnPage,
  params: { checkout: string | null; setup?: string | null },
): void {
  const fired = useRef(false);
  const checkout = params.checkout;
  const setup = params.setup ?? null;

  useEffect(() => {
    if (fired.current) return;
    const tracked = trackCheckoutReturn(
      page,
      { checkout, setup },
      (name, props) => trackFunnelEvent(name, props),
    );
    if (tracked) fired.current = true;
  }, [page, checkout, setup]);
}
