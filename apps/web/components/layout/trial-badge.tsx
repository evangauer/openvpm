"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { AlertTriangle, Clock, CreditCard, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { trialCalendarDaysLeft } from "@/lib/billing/trial-days";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";

/**
 * Trial countdown / read-only indicator in the TopBar. Admin-only and hidden on
 * self-host (billing not enforced) or once a paid subscription is active.
 * During the trial the badge starts Stripe Checkout directly, so "Subscribe"
 * is one click to the payment page instead of a detour through settings.
 */
export function TrialBadge() {
  const { data: session, status } = useSession();
  const isAdmin =
    status === "authenticated" && session?.user?.role === "admin";

  const { data, isLoading, error } = trpc.subscription.get.useQuery(undefined, {
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const checkout = trpc.subscription.createCheckout.useMutation({
    onSuccess: (result) => {
      if (isSafeCheckoutRedirectUrl(result.url)) {
        window.location.href = result.url;
        return;
      }
      toast.error("Billing checkout is unavailable. Please try again.");
    },
    onError: (mutationError) => toast.error(mutationError.message),
  });

  if (!isAdmin) return null;

  if (isLoading) {
    return (
      <span
        aria-label="Checking billing status"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Billing
      </span>
    );
  }

  if (error || !data) {
    return (
      <Link
        href="/settings?tab=billing"
        className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        Billing status unavailable
      </Link>
    );
  }

  if (!data.billingEnforced || data.billingStatus === "active") {
    return null;
  }

  // A Stripe subscription can legitimately remain `trialing` after Checkout
  // while the saved card waits for the free trial to end. Never offer another
  // Checkout in that state; it could create a duplicate subscription.
  if (data.hasSubscription) {
    return (
      <Link
        href="/settings?tab=billing"
        className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-medium text-teal-800 transition-colors hover:bg-teal-100"
      >
        <CreditCard className="h-3.5 w-3.5" />
        Card on file · Manage billing
      </Link>
    );
  }

  const trialing = data.billingStatus === "trialing" && data.trialEndsAt;
  if (trialing) {
    const days =
      trialCalendarDaysLeft(data.trialEndsAt, data.timezone) ?? 0;
    const urgent = days <= 3;
    return (
      <button
        type="button"
        onClick={() => checkout.mutate({ tier: "cloud" })}
        disabled={checkout.isPending}
        aria-label="Subscribe now"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70",
          urgent
            ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
            : "border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100"
        )}
      >
        {checkout.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Clock className="h-3.5 w-3.5" />
        )}
        {days === 0 ? "Trial ends today" : `${days} day${days === 1 ? "" : "s"} left in trial`}
        <span className="font-semibold">· Subscribe</span>
      </button>
    );
  }

  // Billing enforced, not trialing, no full access → lapsed / read-only.
  if (!data.hasFullAccess) {
    return (
      <Link
        href="/settings?tab=billing"
        className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
      >
        <Clock className="h-3.5 w-3.5" />
        Trial ended, read only · Turn it back on
      </Link>
    );
  }

  return null;
}
