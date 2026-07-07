"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  PartyPopper,
  Sparkles,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useTour } from "@/components/tour/tour-provider";

type Milestone = {
  key: string;
  label: string;
  hint: string;
  done: boolean;
} & ({ href: string; onClick?: never } | { onClick: () => void; href?: never });

/**
 * Persistent activation checklist shown on the dashboard through the whole
 * trial. Unlike the old finish-setup card (which only appeared after onboarding
 * "completed" and tracked setup chores), this is value-milestone based and is
 * derived entirely from real practice state — giving a new admin momentum and a
 * concrete reason to come back, all the way to confirming billing is connected.
 */
export function ActivationChecklist() {
  const { start } = useTour();
  const [hidden, setHidden] = useState(false);
  const { data: session, status } = useSession();
  const isAdmin =
    status === "authenticated" && session?.user?.role === "admin";

  // No long staleTime: each dashboard mount re-checks, so a milestone you just
  // completed (uploaded a logo, invited a teammate, asked the AI) shows as done
  // when you come back here.
  const opts = {
    enabled: isAdmin,
    retry: false,
    refetchOnWindowFocus: false,
  } as const;
  const state = trpc.settings.getOnboardingState.useQuery(undefined, opts);
  const onboarding = trpc.settings.onboardingStatus.useQuery(undefined, opts);
  const practice = trpc.settings.getPractice.useQuery(undefined, opts);
  const sub = trpc.subscription.get.useQuery(undefined, opts);
  const texting = trpc.messaging.activationSummary.useQuery(undefined, opts);
  const dismiss = trpc.settings.dismissSetup.useMutation();

  if (!isAdmin) return null;

  const loadError = state.error ?? onboarding.error ?? practice.error ?? sub.error;
  if (loadError) {
    return (
      <ActivationChecklistError
        message={loadError.message}
        onRetry={() => {
          void Promise.all([
            state.refetch(),
            onboarding.refetch(),
            practice.refetch(),
            sub.refetch(),
          ]);
        }}
      />
    );
  }

  const isChecklistLoading =
    state.isLoading ||
    onboarding.isLoading ||
    practice.isLoading ||
    sub.isLoading;

  // Wait for the core signals before rendering so we never flash a wrong state.
  if (isChecklistLoading) return <ActivationChecklistLoading />;
  if (!state.data || !onboarding.data || !practice.data || !sub.data) {
    return (
      <ActivationChecklistError
        message="Setup checklist data was unavailable. Try loading it again."
        onRetry={() => {
          void Promise.all([
            state.refetch(),
            onboarding.refetch(),
            practice.refetch(),
            sub.refetch(),
          ]);
        }}
      />
    );
  }
  if (hidden || state.data.setupDismissed) return null;

  const checklistState = state.data;
  const onboardingData = onboarding.data;
  const practiceData = practice.data;
  const subscriptionData = sub.data;

  const enforced = subscriptionData.billingEnforced;
  const tourDone =
    checklistState.tourStatus === "completed" ||
    checklistState.tourStatus === "skipped";
  const brandColor = (practiceData.settings as { brandColor?: string } | null)
    ?.brandColor;
  const practiceName = practiceData.name ?? "your practice";

  const milestones: Milestone[] = [
    {
      key: "tour",
      label: "Take the 60-second tour",
      hint: "See the schedule, records, billing, and AI in a minute.",
      done: tourDone,
      onClick: () => start(),
    },
    {
      key: "brand",
      label: "Make it your brand",
      hint: "Add your logo and accent color.",
      done: !!practiceData.logoUrl || !!brandColor,
      href: "/settings?tab=practice",
    },
    {
      key: "team",
      label: "Invite a teammate",
      hint: "Bring your doctors and front desk in. Staff is unlimited.",
      done: (subscriptionData.billableSeatCount ?? 1) > 1,
      href: "/settings?tab=staff",
    },
    {
      key: "ai",
      label: "Ask the AI assistant something",
      hint: "Try “Which pets are overdue for vaccines?”",
      done: (subscriptionData.usage?.aiRuns ?? 0) > 0,
      href: "/agent",
    },
    {
      key: "data",
      label: "Bring in your real data",
      hint: "Import clients and pets, then clear the sample data.",
      done: !onboardingData.hasDemoData,
      href: "/settings?tab=data",
    },
    {
      key: "texting",
      label: "Turn on texting",
      hint: "Add a number for reminders and two-way texts with clients.",
      done: texting.data?.hasActiveNumber ?? false,
      href: "/settings?tab=messaging&setup=texting",
    },
    ...(enforced
      ? [
          {
            key: "billing",
            label: "Confirm billing is connected",
            hint: "Stripe keeps the trial ready to convert. Cancel anytime.",
            done: !!subscriptionData.hasBillingAccount,
            href: "/settings?tab=billing",
          } as Milestone,
        ]
      : []),
  ];

  const total = milestones.length;
  const doneCount = milestones.filter((m) => m.done).length;
  const pct = total === 0 ? 100 : (doneCount / total) * 100;
  const allDone = doneCount === total;

  // The corner X just hides the checklist for this session — it comes back next
  // visit ("show later"). "Don't show this again" dismisses it for good.
  function snooze() {
    setHidden(true);
  }
  function dontShowAgain() {
    setHidden(true);
    dismiss.mutate();
  }

  if (allDone) {
    return (
      <Card className="relative flex items-center gap-4 border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <PartyPopper className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-heading text-base font-semibold">
            You&apos;re all set 🎉
          </p>
          <p className="text-sm text-muted-foreground">
            Every setup step is done — {practiceName} is ready to run.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={dontShowAgain}>
          Dismiss
        </Button>
      </Card>
    );
  }

  return (
    <Card className="relative p-5 sm:p-6">
      <button
        type="button"
        onClick={snooze}
        aria-label="Hide for now"
        title="Hide for now"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <p className="font-heading text-base font-semibold">
            Get {practiceName} running
          </p>
          <p className="text-sm text-muted-foreground">
            {doneCount} of {total} complete
          </p>
        </div>
      </div>

      <Progress value={pct} className="mt-4" />

      <div className="mt-4 grid gap-2">
        {milestones.map((m) => {
          const inner = (
            <div
              className={cn(
                "group flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors",
                m.done
                  ? "border-transparent bg-muted/40"
                  : "border-border bg-card hover:border-primary/40 hover:bg-accent"
              )}
            >
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors",
                  m.done
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/30 text-transparent group-hover:border-primary"
                )}
              >
                <Check className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    m.done && "text-muted-foreground line-through"
                  )}
                >
                  {m.label}
                </p>
                {!m.done ? (
                  <p className="text-xs text-muted-foreground">{m.hint}</p>
                ) : null}
              </div>
              {!m.done ? (
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
              ) : null}
            </div>
          );

          if (m.href) {
            return (
              <Link key={m.key} href={m.href} className="block">
                {inner}
              </Link>
            );
          }
          return (
            <button
              key={m.key}
              type="button"
              onClick={m.onClick}
              className="block w-full text-left"
            >
              {inner}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={dontShowAgain}
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Don&apos;t show this again
        </button>
      </div>
    </Card>
  );
}

function ActivationChecklistLoading() {
  return (
    <Card className="p-5 sm:p-6">
      <div className="animate-pulse">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-muted" />
          <div className="space-y-2">
            <div className="h-4 w-48 rounded bg-muted" />
            <div className="h-3 w-24 rounded bg-muted" />
          </div>
        </div>
        <div className="mt-4 h-2 rounded-full bg-muted" />
        <div className="mt-4 grid gap-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-14 rounded-lg border bg-muted/40" />
          ))}
        </div>
      </div>
    </Card>
  );
}

function ActivationChecklistError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Card className="border-destructive/30 bg-destructive/5 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
          <AlertTriangle className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-heading text-base font-semibold">
            Setup checklist could not load
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-3">
            Retry
          </Button>
        </div>
      </div>
    </Card>
  );
}
