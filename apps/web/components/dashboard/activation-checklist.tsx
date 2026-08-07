"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Headphones,
  Loader2,
  PartyPopper,
  Sparkles,
  X,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useTour } from "@/components/tour/tour-provider";
import { toast } from "sonner";
import {
  DEFAULT_ONBOARDING_INTENT,
  getOnboardingIntentOption,
} from "@/lib/onboarding/intent";

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

  // No long staleTime: each dashboard mount re-checks, so operational progress
  // such as publishing booking or completing a visit shows as done immediately.
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
  const booking = trpc.booking.getMyPage.useQuery(undefined, opts);
  const clientPayments = trpc.billing.paymentAccountStatus.useQuery(
    undefined,
    opts
  );
  const dismiss = trpc.settings.dismissSetup.useMutation();
  const utils = trpc.useUtils();
  const requestSetupHelp = trpc.settings.requestOnboardingHelp.useMutation({
    onSuccess: async () => {
      await utils.settings.getOnboardingState.invalidate();
      toast.success("Setup request received");
    },
    onError: (error) => toast.error(error.message),
  });

  if (!isAdmin) return null;

  const loadError =
    state.error ??
    onboarding.error ??
    practice.error ??
    sub.error ??
    texting.error ??
    booking.error ??
    clientPayments.error;
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
            texting.refetch(),
            booking.refetch(),
            clientPayments.refetch(),
          ]);
        }}
      />
    );
  }

  const isChecklistLoading =
    state.isLoading ||
    onboarding.isLoading ||
    practice.isLoading ||
    sub.isLoading ||
    texting.isLoading ||
    booking.isLoading ||
    clientPayments.isLoading;

  // Wait for the core signals before rendering so we never flash a wrong state.
  if (isChecklistLoading) return <ActivationChecklistLoading />;
  if (
    !state.data ||
    !onboarding.data ||
    !practice.data ||
    !sub.data ||
    !texting.data ||
    !booking.data ||
    !clientPayments.data
  ) {
    return (
      <ActivationChecklistError
        message="Setup checklist data was unavailable. Try loading it again."
        onRetry={() => {
          void Promise.all([
            state.refetch(),
            onboarding.refetch(),
            practice.refetch(),
            sub.refetch(),
            texting.refetch(),
            booking.refetch(),
            clientPayments.refetch(),
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
  const textingData = texting.data;
  const bookingData = booking.data;
  const clientPaymentData = clientPayments.data;

  const enforced = subscriptionData.billingEnforced;
  const tourDone =
    checklistState.tourStatus === "completed" ||
    checklistState.tourStatus === "skipped";
  const brandColor = (practiceData.settings as { brandColor?: string } | null)
    ?.brandColor;
  const practiceName = practiceData.name ?? "your practice";
  const pathway = getOnboardingIntentOption(
    checklistState.onboardingIntent ?? DEFAULT_ONBOARDING_INTENT
  );

  const explorationMilestones: Milestone[] = [
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
  ];

  const goLiveMilestones: Milestone[] = [
    {
      key: "data",
      label: "Add one real client and pet",
      hint: "Start small: create one client, then add their pet.",
      done: onboardingData.hasRealData,
      href: "/clients/new",
    },
    {
      key: "firstAppointment",
      label: "Book that pet's first appointment",
      hint: "Put one real appointment on the schedule. Your current PIMS can stay in place.",
      done: onboardingData.hasRealAppointment,
      href: "/schedule",
    },
    {
      key: "team",
      label: "Invite a teammate",
      hint: "Test the handoff between a doctor and the front desk.",
      done: (subscriptionData.billableSeatCount ?? 1) > 1,
      href: "/settings?tab=staff",
    },
    {
      key: "booking",
      label: "Publish online booking",
      hint: "Put one appointment type live and test the client booking path.",
      done: bookingData.page?.published === true,
      href: "/settings?tab=booking",
    },
    {
      key: "texting",
      label: "Start texting registration",
      hint: "Choose a number and submit carrier registration. Approval can take 1–2 weeks.",
      done: textingData.hasAnyNumber,
      href: "/settings?tab=messaging&setup=texting",
    },
    ...(clientPaymentData.stripeConfigured
      ? [
          {
            key: "clientPayments",
            label: "Set up client card payments",
            hint: "Connect the clinic's Stripe account so pet-owner payments go directly to the clinic.",
            done: clientPaymentData.enabled,
            href: "/settings?tab=billing",
          } as Milestone,
        ]
      : []),
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

  // Evaluation remains deliberately light. Clinics running alongside or
  // replacing another PIMS see only the operational go-live path; setup chores
  // such as branding and trying AI stay in the guided tour instead of diluting
  // the activation checklist.
  const standardMilestones =
    pathway.value === "explore"
      ? [
          ...explorationMilestones,
          goLiveMilestones.find((milestone) => milestone.key === "data")!,
        ]
      : pathway.value === "self_host"
        ? [
            explorationMilestones.find(
              (milestone) => milestone.key === "brand"
            )!,
            goLiveMilestones.find((milestone) => milestone.key === "data")!,
            goLiveMilestones.find((milestone) => milestone.key === "team")!,
            goLiveMilestones.find(
              (milestone) => milestone.key === "firstAppointment"
            )!,
          ]
        : goLiveMilestones;
  const firstWinBase =
    standardMilestones.find((milestone) => milestone.key === pathway.firstWinTarget) ??
    standardMilestones[0]!;
  const firstWin: Milestone = {
    ...firstWinBase,
    label: pathway.firstWin,
    hint: pathway.firstWinHint,
  };
  const milestones = [
    firstWin,
    ...standardMilestones.filter((milestone) => milestone.key !== firstWin.key),
  ];

  const total = milestones.length;
  const doneCount = milestones.filter((m) => m.done).length;
  const pct = total === 0 ? 100 : (doneCount / total) * 100;
  const allDone = doneCount === total;
  const setupHelpRequestedAt = checklistState.setupHelpRequestedAt ?? null;

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
      <div className="relative z-20 w-full sm:fixed sm:bottom-4 sm:right-4 sm:z-[70] sm:w-[340px]">
        <div className="flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-zinc-50 shadow-2xl shadow-black/30">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500 text-zinc-950">
            <PartyPopper className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-heading text-sm font-semibold">
              You&apos;re all set 🎉
            </p>
            <p className="text-xs text-zinc-400">
              {practiceName} is ready to run.
            </p>
          </div>
          <button
            type="button"
            onClick={dontShowAgain}
            className="text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-100"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // Docked launcher: a compact dark card pinned bottom-right, out of the way
  // of the day's real work but always one glance from the next setup win.
  return (
    <div className="relative z-20 w-full sm:fixed sm:bottom-4 sm:right-4 sm:z-[70] sm:w-[340px]">
      <div className="relative rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-zinc-50 shadow-2xl shadow-black/30">
        <button
          type="button"
          onClick={snooze}
          aria-label="Hide for now"
          title="Hide for now"
          className="absolute right-3 top-3 rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2.5 pr-6">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-heading text-sm font-semibold">
              Get {practiceName} running
            </p>
            <p className="text-xs text-zinc-400">
              {pathway.shortLabel} · {doneCount} of {total} done
            </p>
          </div>
        </div>

        <Progress
          value={pct}
          className="mt-3 h-1.5 bg-zinc-800 [&>div]:bg-emerald-500"
        />

        <div className="mt-3 max-h-[45vh] space-y-1 overflow-y-auto">
          {milestones.map((m) => {
            const inner = (
              <div
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors",
                  m.done ? "opacity-60" : "hover:bg-zinc-800"
                )}
                title={m.hint}
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
                    m.done
                      ? "border-emerald-500 bg-emerald-500 text-zinc-950"
                      : "border-zinc-600 text-transparent group-hover:border-emerald-400"
                  )}
                >
                  <Check className="h-3 w-3" />
                </span>
                <p
                  className={cn(
                    "min-w-0 flex-1 truncate text-[13px] font-medium",
                    m.done && "text-zinc-400 line-through"
                  )}
                >
                  {m.label}
                </p>
                {!m.done ? (
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:text-emerald-400" />
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

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-zinc-800 pt-2.5">
          {setupHelpRequestedAt ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <Check className="h-3.5 w-3.5" />
              Setup help requested
            </span>
          ) : (
            <button
              type="button"
              onClick={() => requestSetupHelp.mutate()}
              disabled={requestSetupHelp.isPending}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 transition-colors hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {requestSetupHelp.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Headphones className="h-3.5 w-3.5" />
              )}
              Help me set this up
            </button>
          )}
          <button
            type="button"
            onClick={dontShowAgain}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-200"
          >
            Don&apos;t show this again
          </button>
        </div>
      </div>
    </div>
  );
}
function ActivationChecklistLoading() {
  // The docked card simply appears once its data is ready; a floating
  // skeleton in the corner would only draw the eye to nothing.
  return null;
}

function ActivationChecklistError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="relative z-20 w-full sm:fixed sm:bottom-4 sm:right-4 sm:z-[70] sm:w-[340px]">
      <div className="flex items-start gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-zinc-50 shadow-2xl shadow-black/30">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Setup checklist could not load</p>
          <p className="mt-1 text-xs text-zinc-400">{message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="mt-2 border-zinc-700 bg-transparent text-zinc-100 hover:bg-zinc-800"
          >
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}
