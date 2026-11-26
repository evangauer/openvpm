"use client";

import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { PawMark } from "@/components/brand/paw-mark";
import { Button } from "@/components/ui/button";
import { FUNNEL_EVENTS, type FunnelEventName } from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";
import { trpc } from "@/lib/trpc";
import {
  CHECKOUT_WELCOME_ONBOARDING_PATH,
  CHECKOUT_WELCOME_POLL_BUDGET_MS,
  CHECKOUT_WELCOME_POLL_INTERVAL_MS,
  CHECKOUT_WELCOME_SIGN_IN_PATH,
  checkoutWelcomeMessage,
  checkoutWelcomeReturnEvent,
  checkoutWelcomeState,
  checkoutWelcomeTrialEndLabel,
} from "@/lib/billing/checkout-welcome";

export default function WelcomePage() {
  return (
    <Suspense
      fallback={
        <WelcomeFrame>
          <StatusSpinner label="Opening your trial confirmation" />
        </WelcomeFrame>
      }
    >
      <CheckoutWelcome />
    </Suspense>
  );
}

function CheckoutWelcome() {
  const searchParams = useSearchParams();
  const checkout = searchParams.get("checkout");
  const session = useSession();
  const trackedReturn = useRef(false);

  useEffect(() => {
    if (trackedReturn.current) return;
    const event = checkoutWelcomeReturnEvent(FUNNEL_EVENTS, checkout);
    if (!event) return;
    trackedReturn.current = true;
    trackFunnelEvent(event.name as FunnelEventName, {
      source: event.source,
      path: event.path,
    });
  }, [checkout]);

  if (checkout !== "success") {
    return (
      <WelcomeFrame>
        <h1 className="font-heading text-2xl font-bold text-foreground">
          Open your clinic
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Your workspace is ready when you are.
        </p>
        <div className="mt-6">
          {session.status === "authenticated" ? (
            <Button asChild className="w-full">
              <Link href={CHECKOUT_WELCOME_ONBOARDING_PATH}>
                Set up your clinic
              </Link>
            </Button>
          ) : (
            <Button asChild className="w-full">
              <Link href="/login">Sign in</Link>
            </Button>
          )}
        </div>
      </WelcomeFrame>
    );
  }

  if (session.status === "loading") {
    return (
      <WelcomeFrame>
        <StatusSpinner label="Opening your trial confirmation" />
      </WelcomeFrame>
    );
  }

  return (
    <CheckoutSuccess
      authenticated={session.status === "authenticated"}
    />
  );
}

function CheckoutSuccess({ authenticated }: { authenticated: boolean }) {
  const [pollGeneration, setPollGeneration] = useState(0);
  const [pollExpired, setPollExpired] = useState(false);

  useEffect(() => {
    if (!authenticated) return;
    setPollExpired(false);
    const id = window.setTimeout(
      () => setPollExpired(true),
      CHECKOUT_WELCOME_POLL_BUDGET_MS,
    );
    return () => window.clearTimeout(id);
  }, [authenticated, pollGeneration]);

  const subscription = trpc.subscription.get.useQuery(undefined, {
    enabled: authenticated,
    refetchInterval: (query) => {
      if (query.state.data?.hasFullAccess) return false;
      if (pollExpired) return false;
      return CHECKOUT_WELCOME_POLL_INTERVAL_MS;
    },
  });

  const state = checkoutWelcomeState({
    authenticated,
    hasFullAccess: subscription.data?.hasFullAccess === true,
  });
  const trialEndLabel = checkoutWelcomeTrialEndLabel(
    state === "active"
      ? { trialEndsAt: subscription.data?.trialEndsAt ?? null }
      : undefined,
  );
  const message = checkoutWelcomeMessage(trialEndLabel);

  return (
    <WelcomeFrame>
      {state === "finalizing" ? (
        <div role="status" aria-live="polite">
          <StatusSpinner label="Finalizing your trial" />
          <h1 className="mt-4 font-heading text-2xl font-bold text-foreground">
            Finalizing your trial
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Stripe is confirming your card. You won&apos;t be charged today.
          </p>
          {pollExpired ? (
            <div className="mt-4">
              <p className="text-sm leading-6 text-muted-foreground">
                This is taking longer than usual. Your trial starts as soon as
                the confirmation arrives.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4 w-full"
                onClick={() => {
                  setPollGeneration((generation) => generation + 1);
                  void subscription.refetch();
                }}
              >
                Check again
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div role="status" aria-live="polite">
          <h1 className="font-heading text-2xl font-bold text-foreground">
            Your trial is active
          </h1>
          <p className="mt-3 text-sm leading-6 text-foreground">{message}</p>
          <div className="mt-6">
            {state === "active" ? (
              <Button asChild className="w-full">
                <Link href={CHECKOUT_WELCOME_ONBOARDING_PATH}>
                  Set up your clinic
                </Link>
              </Button>
            ) : (
              <Button asChild className="w-full">
                <Link href={CHECKOUT_WELCOME_SIGN_IN_PATH}>Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      )}
    </WelcomeFrame>
  );
}

function WelcomeFrame({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-surface p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <PawMark className="h-6 w-6" />
          </span>
          <p className="font-heading text-sm font-semibold text-foreground">
            OpenVPM
          </p>
        </div>
        {children}
      </div>
    </main>
  );
}

function StatusSpinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center" role="status">
      <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
