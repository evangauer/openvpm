"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ArrowRight, Check, PartyPopper, Sparkles, X } from "lucide-react";
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
 * concrete reason to come back, all the way to "add billing to keep your data".
 */
export function ActivationChecklist() {
  const { start } = useTour();
  const [hidden, setHidden] = useState(false);
  const { data: session, status } = useSession();
  const isAdmin =
    status === "authenticated" && session?.user?.role === "admin";

  const opts = {
    enabled: isAdmin,
    retry: false,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  } as const;
  const state = trpc.settings.getOnboardingState.useQuery(undefined, opts);
  const onboarding = trpc.settings.onboardingStatus.useQuery(undefined, opts);
  const practice = trpc.settings.getPractice.useQuery(undefined, opts);
  const sub = trpc.subscription.get.useQuery(undefined, opts);
  const dismiss = trpc.settings.dismissSetup.useMutation();

  // Wait for the core signals before rendering so we never flash a wrong state.
  if (!isAdmin || !state.data || !onboarding.data || !sub.data) return null;
  if (hidden || state.data.setupDismissed) return null;

  const enforced = sub.data.billingEnforced;
  const tourDone =
    state.data.tourStatus === "completed" ||
    state.data.tourStatus === "skipped";

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
      done: !!practice.data?.logoUrl,
      href: "/settings?tab=practice",
    },
    {
      key: "team",
      label: "Invite a teammate",
      hint: "Bring your doctors and front desk in. Staff is unlimited.",
      done: (sub.data.billableSeatCount ?? 1) > 1,
      href: "/settings?tab=staff",
    },
    {
      key: "ai",
      label: "Ask the AI assistant something",
      hint: "Try “Which pets are overdue for vaccines?”",
      done: (sub.data.usage?.aiRuns ?? 0) > 0,
      href: "/agent",
    },
    {
      key: "data",
      label: "Bring in your real data",
      hint: "Import clients and pets, then clear the sample data.",
      done: !onboarding.data.hasDemoData,
      href: "/settings?tab=data",
    },
    ...(enforced
      ? [
          {
            key: "billing",
            label: "Add billing to keep your data",
            hint: "Add a card before your trial ends. Cancel anytime.",
            done: !!sub.data.hasBillingAccount,
            href: "/settings?tab=billing",
          } as Milestone,
        ]
      : []),
  ];

  const total = milestones.length;
  const doneCount = milestones.filter((m) => m.done).length;
  const pct = total === 0 ? 100 : (doneCount / total) * 100;
  const allDone = doneCount === total;

  function onDismiss() {
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
            Every setup step is done — {practice.data?.name ?? "your practice"} is
            ready to run.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </Card>
    );
  }

  return (
    <Card className="relative p-5 sm:p-6">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss checklist"
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
            Get {practice.data?.name ?? "your practice"} running
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
    </Card>
  );
}
