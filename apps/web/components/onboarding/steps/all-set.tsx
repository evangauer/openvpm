"use client";

import { useEffect } from "react";
import {
  CalendarCheck2,
  CalendarPlus,
  Check,
  CreditCard,
  Globe2,
  PawPrint,
  ReceiptText,
  UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { JourneyState, StepHandle } from "../journey-types";

type RecommendationTone = "primary" | "violet" | "coral";

const RECOMMENDATION_TONES: Record<
  RecommendationTone,
  { picture: string; icon: string; tag: string }
> = {
  primary: {
    picture: "from-emerald-50 to-teal-50",
    icon: "bg-primary/10 text-primary",
    tag: "bg-primary/10 text-primary",
  },
  violet: {
    picture: "from-violet-50 to-sky-50",
    icon: "bg-violet-100 text-violet-700",
    tag: "bg-violet-100 text-violet-700",
  },
  coral: {
    picture: "from-orange-50 to-rose-50",
    icon: "bg-orange-100 text-orange-700",
    tag: "bg-orange-100 text-orange-700",
  },
};

function RecommendationCard({
  title,
  body,
  tag,
  tone,
  tilt,
  children,
}: {
  title: string;
  body: string;
  tag: string;
  tone: RecommendationTone;
  tilt: string;
  children: React.ReactNode;
}) {
  const palette = RECOMMENDATION_TONES[tone];
  return (
    <li
      className={cn(
        "group flex min-w-0 flex-col rounded-sm bg-white p-3 pb-4 shadow-[0_18px_40px_-24px_rgba(15,23,42,0.55)] ring-1 ring-black/5",
        "transition duration-300 ease-out hover:z-10 hover:rotate-0 hover:-translate-y-1.5 hover:shadow-xl",
        "motion-reduce:transform-none motion-reduce:transition-none",
        tilt,
      )}
    >
      <div
        className={cn(
          "flex min-h-32 flex-col justify-between overflow-hidden rounded-[3px] bg-gradient-to-br p-4",
          palette.picture,
        )}
      >
        {children}
      </div>
      <h4 className="mt-3 font-heading text-base font-semibold leading-snug text-slate-950">
        {title}
      </h4>
      <p className="mt-1 text-xs leading-5 text-slate-600">{body}</p>
      <span
        className={cn(
          "mt-3 w-fit rounded-full px-2.5 py-1 text-[10px] font-semibold",
          palette.tag,
        )}
      >
        {tag}
      </span>
    </li>
  );
}

/**
 * Closing step: turn setup momentum into the first real clinic action. The
 * overlay completes guided setup and routes to the action named here.
 */
export function AllSetStep({
  register,
  state,
}: {
  register: (h: StepHandle) => void;
  state: JourneyState;
}) {
  const hasImportedData = state.hasImportedData;
  useEffect(() => {
    register({
      continueLabel: hasImportedData
        ? "Book the first appointment"
        : "Add the first real client",
      onContinue: async () => true,
    });
  }, [hasImportedData, register]);

  const Icon = hasImportedData ? CalendarPlus : UserPlus;

  return (
    <div className="space-y-7">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          {hasImportedData
            ? "Your reviewed records are saved. Start with one real appointment, then decide what deserves a larger rollout."
            : "Your clinic basics are saved. Start with one real client and visit while your current PIMS stays safely in place."}
        </p>
      </div>

      <section aria-labelledby="first-day-recommendations-heading">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <div>
            <h3
              id="first-day-recommendations-heading"
              className="font-heading text-xl font-semibold text-slate-950"
            >
              Here’s what I think will help first.
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              Pick one useful win. The rest will still be here when you’re
              ready.
            </p>
          </div>
          <p className="text-xs text-slate-500">Nothing here blocks launch.</p>
        </div>

        <ul className="mt-6 grid gap-6 sm:grid-cols-3 sm:gap-5">
          <RecommendationCard
            title={
              hasImportedData
                ? "Book one real appointment"
                : "Run one real visit"
            }
            body={
              hasImportedData
                ? "Choose a patient from your reviewed records and put one visit on the schedule."
                : "Add one owner and pet, then work from check-in through the client handoff."
            }
            tag="Best next step"
            tone="primary"
            tilt="sm:-rotate-1"
          >
            <span className="flex items-center gap-2 text-xs font-semibold text-primary">
              <CalendarCheck2 className="h-4 w-4" /> Your clinic day
            </span>
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-lg bg-white/90 px-3 py-2 text-xs text-slate-700 shadow-sm">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <PawPrint className="h-3.5 w-3.5" />
                </span>
                <span>{hasImportedData ? "First visit" : "New patient"}</span>
                <Check className="ml-auto h-3.5 w-3.5 text-primary" />
              </div>
            </div>
          </RecommendationCard>

          <RecommendationCard
            title="Make getting paid easy"
            body="Send an online invoice and let clients pay by card from their private link."
            tag="Get paid faster"
            tone="violet"
            tilt="sm:rotate-1"
          >
            <span className="flex items-center gap-2 text-xs font-semibold text-violet-700">
              <ReceiptText className="h-4 w-4" /> Client billing
            </span>
            <div className="rounded-lg bg-white/90 px-3 py-2.5 shadow-sm">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Invoice total</span>
                <span className="font-semibold text-slate-900">$68.00</span>
              </div>
              <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-violet-700">
                <CreditCard className="h-3.5 w-3.5" /> Pay securely online
              </div>
            </div>
          </RecommendationCard>

          <RecommendationCard
            title="Give clients one simple place"
            body="Share visits, vaccine history, and bills through a private client portal."
            tag="Fewer status calls"
            tone="coral"
            tilt="sm:-rotate-1"
          >
            <span className="flex items-center gap-2 text-xs font-semibold text-orange-700">
              <Globe2 className="h-4 w-4" /> Client portal
            </span>
            <div className="flex items-center gap-2 rounded-lg bg-white/90 px-3 py-2.5 shadow-sm">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-100 text-orange-700">
                <PawPrint className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900">
                  Everything in one link
                </p>
                <p className="text-[10px] text-slate-500">
                  Visits · Vaccines · Bills
                </p>
              </div>
            </div>
          </RecommendationCard>
        </ul>
      </section>
    </div>
  );
}
