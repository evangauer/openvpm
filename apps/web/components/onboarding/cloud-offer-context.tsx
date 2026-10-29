import React from "react";

export function CloudOfferContext({
  hostedBilling,
  cardRequired,
  trialDays,
  monthlyPriceUsd,
}: {
  hostedBilling: boolean;
  cardRequired: boolean;
  trialDays: number;
  monthlyPriceUsd: number;
}) {
  if (!hostedBilling) return null;

  return (
    <aside
      aria-label="OpenVPM Cloud offer"
      className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm leading-6 text-slate-700"
    >
      <p>
        <strong className="font-semibold text-slate-950">OpenVPM Cloud:</strong>{" "}
        {trialDays}-day free trial.{" "}
        {cardRequired
          ? `Card required; no subscription charge today. After the trial, billing starts automatically at $${monthlyPriceUsd} USD/month per active location, plus applicable taxes and usage overages, unless you cancel before the trial ends.`
          : `No card required to start. Cloud pricing is $${monthlyPriceUsd} USD/month per active location, plus applicable taxes and usage overages.`}{" "}
        Clinic go-live is a guided pilot.
      </p>
      <p className="mt-1">
        <a
          className="font-medium text-emerald-800 underline underline-offset-2"
          href="https://openvpm.com/pricing"
        >
          Pricing and trial details
        </a>
        {" · "}
        <a
          className="font-medium text-emerald-800 underline underline-offset-2"
          href="/legal/terms"
        >
          Terms of Service
        </a>
      </p>
    </aside>
  );
}
