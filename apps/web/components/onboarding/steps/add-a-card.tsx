"use client";

import { useEffect, useState } from "react";
import { CreditCard, Loader2, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import { toast } from "sonner";
import type { StepHandle } from "../journey-types";

/**
 * Optional step: add a card to lock in the plan. Never forced — Continue always
 * skips. "Add a card" opens Stripe Checkout (off-site); before redirecting we
 * advance the durable journey cursor to the closing step, so when Stripe returns
 * to the app the wizard resumes at "You're all set" rather than back here.
 */
export function AddACardStep({
  register,
}: {
  register: (h: StepHandle) => void;
}) {
  const subscription = trpc.subscription.get.useQuery(undefined, {
    retry: false,
  });
  const setJourneyProgress = trpc.settings.setJourneyProgress.useMutation();
  const createCheckout = trpc.subscription.createCheckout.useMutation();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    // Skippable: Continue never blocks.
    register({ onContinue: async () => true });
  }, [register]);

  const unitPrice = subscription.data?.locationUnitPriceMonthlyUsd ?? 79;
  const alreadyHasCard = Boolean(
    subscription.data?.hasSubscription || subscription.data?.hasBillingAccount
  );

  async function addCard() {
    if (redirecting) return;
    setRedirecting(true);
    try {
      // Resume at the closing step when Stripe sends the user back.
      await setJourneyProgress.mutateAsync({ stepId: "allSet" });
      const result = await createCheckout.mutateAsync({
        tier: "cloud",
        // Stripe sends the admin back into the guided setup, not billing.
        returnTo: "setup",
      });
      const url = result?.url;
      if (!url || !isSafeCheckoutRedirectUrl(url)) {
        toast.error("Checkout is unavailable right now. Please try again.");
        setRedirecting(false);
        return;
      }
      window.location.href = url;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start checkout."
      );
      setRedirecting(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm leading-6 text-slate-600">
        This is optional. Your 14-day trial is fully featured and needs no card.
        Add one whenever you are ready and your plan continues without a gap when
        the trial ends.
      </p>

      <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-slate-600">OpenVPM Cloud</span>
          <span className="font-heading text-lg font-bold text-slate-900">
            ${unitPrice}
            <span className="text-sm font-normal text-slate-500">
              /location / month
            </span>
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Unlimited staff included. Billed only after your free trial.
        </p>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-500">
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        Payments are handled securely by Stripe. Cancel anytime.
      </div>

      {alreadyHasCard ? (
        <p className="text-sm font-medium text-emerald-700">
          A card is already on file. You are all set.
        </p>
      ) : (
        <Button type="button" variant="outline" onClick={addCard} disabled={redirecting}>
          {redirecting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <CreditCard className="mr-2 h-4 w-4" />
          )}
          Add a card
        </Button>
      )}
    </div>
  );
}
