"use client";

import { CreditCard, Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { checkoutTrialSummary } from "@/lib/billing/checkout-summary";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import { trpc } from "@/lib/trpc";

/**
 * One-click return to Stripe for clinics that cancelled Checkout and still
 * have no subscription and no active trial. Hidden on Plan & Billing, which
 * has its own resume button.
 */
export function ResumeCheckoutBanner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const isAdmin = status === "authenticated" && session?.user?.role === "admin";
  const onBillingTab =
    pathname === "/settings" && searchParams.get("tab") === "billing";
  const { data } = trpc.subscription.get.useQuery(undefined, {
    enabled: isAdmin && !onBillingTab,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const checkout = trpc.subscription.createCheckout.useMutation({
    onSuccess: (result) => {
      if (!isSafeCheckoutRedirectUrl(result.url)) {
        toast.error("Billing checkout is unavailable. Please try again.");
        return;
      }
      window.location.href = result.url;
    },
    onError: (error) => toast.error(error.message),
  });

  if (!isAdmin || onBillingTab || !data?.canResumeCheckout) return null;

  const summary = checkoutTrialSummary({
    configuredPriceUsd: data.locationUnitPriceMonthlyUsd,
    plan: data.plans.find((plan) => plan.tier === "cloud") ?? null,
  });

  return (
    <aside
      aria-label="Resume checkout"
      className="border-b border-primary/20 bg-primary/5 px-4 py-3 sm:px-6"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-medium text-foreground">{summary.text}</p>
        <Button
          type="button"
          className="w-full gap-2 sm:w-auto"
          disabled={checkout.isPending}
          onClick={() =>
            checkout.mutate({ tier: "cloud", billingCadence: "month" })
          }
        >
          {checkout.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CreditCard className="size-4" />
          )}
          Resume checkout
        </Button>
      </div>
    </aside>
  );
}
