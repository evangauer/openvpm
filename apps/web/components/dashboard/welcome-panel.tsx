"use client";

import { useEffect, useState } from "react";
import { ArrowRight, PawPrint, Sparkles, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTour } from "@/components/tour/tour-provider";
import { useOnboardingJourney } from "@/components/onboarding/journey-overlay";

/**
 * The first-load welcome beat. Shown only right after signup (the register flow
 * lands on `/?welcome=1`), it greets the new practice by name and offers value
 * first: take a quick tour, explore on your own, or walk a guided setup. Tour
 * and guided setup are opt-in — nothing is forced in front of the live product.
 */
export function WelcomePanel() {
  const { start } = useTour();
  const { openJourney } = useOnboardingJourney();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const wanted =
      new URLSearchParams(window.location.search).get("welcome") === "1";
    setShow(wanted);
  }, []);

  const practice = trpc.settings.getPractice.useQuery(undefined, {
    enabled: show,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const onboarding = trpc.settings.onboardingStatus.useQuery(undefined, {
    enabled: show,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (!show) return null;

  const hasSample = onboarding.data?.hasDemoData ?? true;
  const name = practice.data?.name?.trim();

  function dismiss() {
    setShow(false);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("welcome");
      window.history.replaceState({}, "", url.toString());
    }
  }

  return (
    <Card className="relative animate-in fade-in slide-in-from-top-2 overflow-hidden border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card duration-500">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss welcome"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="p-6 sm:p-8">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <PawPrint className="h-5 w-5" />
        </span>

        <h2 className="mt-4 font-heading text-2xl font-bold tracking-tight">
          Welcome to OpenVPM{name ? `, ${name}` : ""} 🎉
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          {hasSample
            ? "We set up a sample practice — real clients, pets, and appointments — so the app feels alive. Poke around, then make it yours. Your 14-day trial is fully featured, no card needed."
            : "Your workspace is ready. Add your first client and patient to get going. Your 14-day trial is fully featured, no card needed."}
        </p>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button onClick={() => start()}>
            <Sparkles className="mr-2 h-4 w-4" />
            Take the 60-second tour
          </Button>
          <Button variant="ghost" onClick={dismiss}>
            Explore on my own
          </Button>
        </div>

        <button
          type="button"
          onClick={() => {
            dismiss();
            openJourney();
          }}
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          Prefer a guided setup? Walk through it
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </Card>
  );
}
