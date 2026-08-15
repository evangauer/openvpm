"use client";

import type { ReactNode } from "react";

import {
  Building2,
  CalendarCheck2,
  Check,
  ClipboardCheck,
  Compass,
  Dog,
  FilePlus2,
  Files,
  FlaskConical,
  HeartPulse,
  Home,
  Leaf,
  PawPrint,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Truck,
  UserRoundPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CLINIC_MODEL_OPTIONS,
  FIRST_GOAL_OPTIONS,
  SELF_HOST_GOAL,
  clinicModelOption,
  firstDayTasks,
  type ClinicModel,
  type FirstGoal,
} from "@/lib/onboarding/clinic-profile";

const modelIcons = {
  companion: Dog,
  mobile: Truck,
  equine: Leaf,
  specialty: HeartPulse,
  shelter: Home,
  exploring: Compass,
} satisfies Record<ClinicModel, typeof Dog>;

const goalIcons = {
  run_visit: CalendarCheck2,
  import_records: Files,
  start_fresh: FilePlus2,
  explore_sample: FlaskConical,
  self_host: Building2,
} satisfies Record<FirstGoal, typeof CalendarCheck2>;

const taskIcons = [
  CalendarCheck2,
  UserRoundPlus,
  Stethoscope,
  ClipboardCheck,
] as const;

const toneClasses = {
  emerald: "bg-emerald-50 text-emerald-700",
  coral: "bg-orange-50 text-orange-700",
  lavender: "bg-violet-50 text-violet-700",
  blue: "bg-sky-50 text-sky-700",
  rose: "bg-rose-50 text-rose-700",
  amber: "bg-amber-50 text-amber-700",
} as const;

export function ClinicIntentBuilder({
  clinicModel,
  firstGoal,
  onClinicModelChange,
  onFirstGoalChange,
  intro = "Start with one useful workflow. We’ll shape OpenVPM around the way your team works—and you stay in control.",
  showClinicModel = true,
  showFirstGoal = true,
  goalLegend = "What would feel useful first?",
  beforeChoices,
  afterChoices,
}: {
  clinicModel: ClinicModel;
  firstGoal: FirstGoal;
  onClinicModelChange: (model: ClinicModel) => void;
  onFirstGoalChange: (goal: FirstGoal) => void;
  intro?: string | null;
  showClinicModel?: boolean;
  showFirstGoal?: boolean;
  goalLegend?: string;
  beforeChoices?: ReactNode;
  afterChoices?: ReactNode;
}) {
  const selectedModel = clinicModelOption(clinicModel);
  const tasks = firstDayTasks(clinicModel, firstGoal);
  const goalOptions =
    clinicModel === "exploring"
      ? [...FIRST_GOAL_OPTIONS, SELF_HOST_GOAL]
      : FIRST_GOAL_OPTIONS;

  return (
    <div
      className={cn(
        "grid gap-6",
        showFirstGoal &&
          "lg:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)] lg:items-start lg:gap-8",
      )}
    >
      <div className="min-w-0">
        {beforeChoices}

        {intro ? (
          <p className="max-w-2xl text-[15px] leading-7 text-slate-600 sm:text-base">
            {intro}
          </p>
        ) : null}

        {showClinicModel ? (
          <fieldset className={intro ? "mt-7" : undefined}>
            <legend className="text-sm font-semibold text-slate-950 sm:text-base">
              What kind of care do you provide?
            </legend>
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
              {CLINIC_MODEL_OPTIONS.map((option) => {
                const Icon = modelIcons[option.value];
                const active = clinicModel === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onClinicModelChange(option.value)}
                    className={cn(
                      "group relative min-h-[104px] rounded-2xl border bg-white p-3 text-left transition duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:min-h-[118px] sm:p-4",
                      active
                        ? "-translate-y-0.5 border-primary bg-primary/5 shadow-[0_12px_30px_-18px_rgba(5,150,105,0.65)]"
                        : "border-slate-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_10px_24px_-20px_rgba(15,23,42,0.45)]",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105",
                        toneClasses[option.tone],
                      )}
                    >
                      <Icon className="h-5 w-5" strokeWidth={1.8} />
                    </span>
                    <span className="mt-2.5 block max-w-[10rem] text-[13px] font-semibold leading-[1.3] text-slate-900 sm:text-sm">
                      {option.label}
                    </span>
                    {active ? (
                      <span className="absolute right-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {showFirstGoal ? (
          <fieldset
            className={
              showClinicModel || intro || beforeChoices ? "mt-6" : undefined
            }
          >
            <legend className="text-sm font-semibold text-slate-950 sm:text-base">
              {goalLegend}
            </legend>
            <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
              {goalOptions.map((option) => {
                const Icon = goalIcons[option.value];
                const active = firstGoal === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onFirstGoalChange(option.value)}
                    className={cn(
                      "flex min-h-14 items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                      active
                        ? "border-primary bg-primary/5 shadow-[0_8px_24px_-20px_rgba(5,150,105,0.7)]"
                        : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                        active
                          ? "bg-primary/10 text-primary"
                          : "bg-violet-50 text-violet-700",
                      )}
                    >
                      <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                    </span>
                    <span className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-slate-800 sm:text-sm">
                      {option.label}
                    </span>
                    <span
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-slate-300 bg-white text-transparent",
                      )}
                    >
                      <Check className="h-3 w-3" strokeWidth={2.5} />
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {afterChoices}
      </div>

      {showFirstGoal ? (
        <aside
          aria-live="polite"
          className="relative overflow-hidden rounded-[24px] border border-primary/15 bg-[linear-gradient(155deg,#ffffff_0%,#f5fbf8_72%,#f7f5ff_100%)] px-5 py-5 shadow-[0_24px_60px_-42px_rgba(5,150,105,0.55)] sm:px-6 sm:py-6 lg:min-h-[480px]"
        >
          <div
            aria-hidden="true"
            className="absolute -right-10 -top-10 h-32 w-32 rounded-full border border-violet-100/80"
          />
          <div
            aria-hidden="true"
            className="absolute -right-4 top-6 h-20 w-20 rounded-full border border-rose-100"
          />
          <div className="relative">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary lg:hidden">
                <Sparkles className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <div>
                <h3 className="font-heading text-lg font-semibold text-slate-950 sm:text-xl">
                  Your first OpenVPM day
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Shaped for {selectedModel.shortLabel.toLowerCase()} care
                </p>
              </div>
            </div>

            <ol key={`${clinicModel}-${firstGoal}`} className="mt-4 space-y-2">
              {tasks.map((task, index) => {
                const Icon = taskIcons[index] ?? PawPrint;
                return (
                  <li
                    key={task}
                    style={{ animationDelay: `${index * 90}ms` }}
                    className="onboarding-task-in relative flex items-center gap-3 rounded-2xl border border-white bg-white/90 p-2.5 shadow-[0_12px_30px_-22px_rgba(15,23,42,0.4)] sm:p-3"
                  >
                    <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground shadow-sm">
                      {index + 1}
                    </span>
                    <span className="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                    </span>
                    <span className="text-sm font-medium leading-5 text-slate-800">
                      {task}
                    </span>
                  </li>
                );
              })}
            </ol>

            <div className="mt-4 flex items-center gap-2 text-xs text-primary">
              <ShieldCheck className="h-4 w-4" strokeWidth={1.8} />
              <span>Nothing moves until you review it.</span>
            </div>
          </div>
          <style>{`
          @keyframes onboarding-task-in {
            from { opacity: 0; transform: translateY(7px); }
            to { opacity: 1; transform: translateY(0); }
          }
          .onboarding-task-in { animation: onboarding-task-in 320ms ease-out backwards; }
          @media (prefers-reduced-motion: reduce) { .onboarding-task-in { animation: none; } }
        `}</style>
        </aside>
      ) : null}
    </div>
  );
}
