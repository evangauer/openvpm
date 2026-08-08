"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSession } from "next-auth/react";
import { ArrowLeft, ArrowRight, Loader2, PawPrint } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useTour } from "@/components/tour/tour-provider";
import { firstRunMode } from "@/lib/welcome/first-run";
import {
  DEFAULT_ONBOARDING_INTENT,
  type OnboardingIntent,
} from "@/lib/onboarding/intent";
import type { JourneyState, StepHandle } from "./journey-types";
import { ChoosePathStep } from "./steps/choose-path";
import { PracticeBasicsStep } from "./steps/practice-basics";
import { BrandingStep } from "./steps/branding";
import { InviteTeamStep } from "./steps/invite-team";
import { BringDataStep } from "./steps/bring-data";
import { TryAgentStep } from "./steps/try-agent";
import { SetUpTextingStep } from "./steps/set-up-texting";
import { AddACardStep } from "./steps/add-a-card";
import { AllSetStep } from "./steps/all-set";

type StepId =
  | "intent"
  | "basics"
  | "branding"
  | "team"
  | "data"
  | "agent"
  | "phone"
  | "billing"
  | "allSet";

interface StepDef {
  id: StepId;
  title: string;
}

/**
 * The effective step list. Billing ("add a card") only appears on the hosted
 * service; self-host has nothing to charge. The closing "all set" step always
 * comes last and offers the quick product tour.
 */
function buildSteps(billingEnforced: boolean): StepDef[] {
  return [
    { id: "intent", title: "How do you want to start?" },
    { id: "basics", title: "Tell us about your clinic." },
    { id: "branding", title: "Make it feel like yours." },
    { id: "team", title: "Bring your team in." },
    { id: "data", title: "Add your real clients and pets." },
    { id: "agent", title: "Try your AI helper." },
    { id: "phone", title: "Set up texting." },
    ...(billingEnforced
      ? [{ id: "billing" as const, title: "Add a card." }]
      : []),
    { id: "allSet", title: "You're all set." },
  ];
}

interface OnboardingJourneyContextValue {
  /** Open the "Make it yours" guided setup (resumes at the saved step). */
  openJourney: () => void;
  isOpen: boolean;
}

const OnboardingJourneyContext = createContext<OnboardingJourneyContextValue>({
  openJourney: () => {},
  isOpen: false,
});

export function useOnboardingJourney() {
  return useContext(OnboardingJourneyContext);
}

/**
 * Provides the "Make it yours" guided setup. It auto-opens once for a new admin
 * whose onboarding isn't finished (and wasn't dismissed with "I'll finish
 * later"), resuming at the saved step. The welcome panel and activation
 * checklist can also invoke `openJourney()` explicitly. Mount once in the
 * dashboard layout. Each step runs its own server work on Continue; finishing
 * marks onboarding complete (and clears the sample data unless the user chose to
 * keep it), then optionally launches the quick product tour.
 */
export function OnboardingJourneyProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  const isAdmin = status === "authenticated" && session?.user?.role === "admin";

  const onboardingStatus = trpc.settings.onboardingStatus.useQuery(undefined, {
    enabled: isAdmin,
  });
  const onboardingState = trpc.settings.getOnboardingState.useQuery(undefined, {
    enabled: isAdmin,
  });
  const subscription = trpc.subscription.get.useQuery(undefined, {
    enabled: isAdmin,
  });

  const billingEnforced = subscription.data?.billingEnforced ?? false;
  const steps = useMemo(() => buildSteps(billingEnforced), [billingEnforced]);

  const journeyStepId = onboardingState.data?.journeyStepId ?? null;
  const onboardingIntent = onboardingState.data?.onboardingIntent ?? null;
  const resumeIndex = useMemo(() => {
    // Anyone who started before pathways existed gets the new choice once.
    if (!onboardingIntent) return 0;
    const i = steps.findIndex((s) => s.id === journeyStepId);
    return i >= 0 ? i : 0;
  }, [steps, journeyStepId, onboardingIntent]);

  // null = closed; a number is the active step index.
  const [index, setIndex] = useState<number | null>(null);
  // Opens at most once per mount, so finishing/dismissing never reopens it.
  const opened = useRef(false);

  const openJourney = useCallback(() => {
    if (!isAdmin) return;
    setIndex(resumeIndex);
  }, [isAdmin, resumeIndex]);

  // Returning from Stripe Checkout during setup: ?setup=resume reopens the
  // journey at the saved step (the card step persisted "allSet" before the
  // redirect), instead of stranding the admin wherever Stripe landed them.
  useEffect(() => {
    if (opened.current || index !== null || !isAdmin) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("setup") !== "resume") return;
    if (!onboardingState.data) return; // wait for the saved cursor
    opened.current = true;
    params.delete("setup");
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (rest ? `?${rest}` : ""),
    );
    setIndex(resumeIndex);
  }, [isAdmin, index, onboardingState.data, resumeIndex]);

  useEffect(() => {
    if (opened.current || index !== null || !isAdmin) return;
    // In "welcome" first-run mode the Polaroid guide surface owns the
    // greeting; the wizard opens on demand (welcome footer, first-win
    // offer, activation checklist). NEXT_PUBLIC_FIRST_RUN_MODE=wizard
    // restores this auto-open exactly.
    if (firstRunMode() === "welcome") return;
    // Wait until all gates are loaded so the step list + resume point are stable.
    if (!onboardingStatus.data || !onboardingState.data || !subscription.data) {
      return;
    }
    const notFinished = onboardingStatus.data.completedAt == null;
    const dismissed = onboardingState.data.journeyDismissed === true;
    // Practices already running on real data (seeded demo, self-host
    // upgrades) never get greeted like a brand-new signup.
    const established = onboardingStatus.data.establishedPractice === true;
    if (notFinished && !dismissed && !established) {
      opened.current = true;
      setIndex(resumeIndex);
    }
  }, [
    isAdmin,
    index,
    onboardingStatus.data,
    onboardingState.data,
    subscription.data,
    resumeIndex,
  ]);

  const isOpen = isAdmin && index !== null;

  return (
    <OnboardingJourneyContext.Provider value={{ openJourney, isOpen }}>
      {children}
      {isOpen ? (
        <JourneyShell
          steps={steps}
          index={index!}
          setIndex={setIndex}
          initialIntent={onboardingIntent ?? DEFAULT_ONBOARDING_INTENT}
        />
      ) : null}
    </OnboardingJourneyContext.Provider>
  );
}

/**
 * The mounted overlay. Split out so its hooks only run while the journey is
 * actually open. The step index lives in the parent for the open-once guard.
 */
function JourneyShell({
  steps,
  index,
  setIndex,
  initialIntent,
}: {
  steps: StepDef[];
  index: number;
  setIndex: (i: number | null) => void;
  initialIntent: OnboardingIntent;
}) {
  const utils = trpc.useUtils();
  const { start: startTour } = useTour();
  const completeOnboarding = trpc.settings.completeOnboarding.useMutation();
  const clearDemoData = trpc.settings.clearDemoData.useMutation();
  const setJourneyProgress = trpc.settings.setJourneyProgress.useMutation();

  // Shared step state. Default to keeping sample data and offering the tour.
  const [state, setStateRaw] = useState<JourneyState>({
    onboardingIntent: initialIntent,
    keepSampleData: true,
    startTourAfter: true,
  });
  const setState = useCallback(
    (patch: Partial<JourneyState>) =>
      setStateRaw((prev) => ({ ...prev, ...patch })),
    [],
  );

  // The active step registers its Continue handler here.
  const handleRef = useRef<StepHandle | null>(null);
  const [continueLabel, setContinueLabel] = useState<string | null>(null);
  const [continueDisabled, setContinueDisabled] = useState(false);
  const register = useCallback((h: StepHandle) => {
    handleRef.current = h;
    setContinueLabel(h.continueLabel ?? null);
    setContinueDisabled(h.continueDisabled ?? false);
  }, []);

  const [busy, setBusy] = useState(false);
  const total = steps.length;
  const step = steps[index]!;
  const isLast = index >= total - 1;

  // Persist the resume cursor (durable + optimistic) so a reload resumes here.
  const persistCursor = useCallback(
    (stepId: string) => {
      utils.settings.getOnboardingState.setData(undefined, (prev) =>
        prev ? { ...prev, journeyStepId: stepId } : prev,
      );
      setJourneyProgress.mutate({ stepId });
    },
    [utils, setJourneyProgress],
  );

  const finish = useCallback(async () => {
    await completeOnboarding.mutateAsync();
    if (!state.keepSampleData) {
      try {
        await clearDemoData.mutateAsync();
      } catch {
        // Clearing sample data is best-effort; never block finishing on it.
      }
    }
    await Promise.all([
      utils.settings.onboardingStatus.invalidate(),
      utils.settings.getOnboardingState.invalidate(),
    ]);
    setIndex(null);
    // Chain the quick product tour if the user opted in on the last step.
    if (state.startTourAfter) {
      startTour();
    }
  }, [
    completeOnboarding,
    clearDemoData,
    state.keepSampleData,
    state.startTourAfter,
    utils,
    setIndex,
    startTour,
  ]);

  const handleContinue = useCallback(async () => {
    if (busy || continueDisabled) return;
    setBusy(true);
    try {
      const advance = handleRef.current
        ? await handleRef.current.onContinue()
        : true;
      if (!advance) return;
      if (isLast) {
        await finish();
      } else {
        handleRef.current = null;
        setContinueLabel(null);
        setContinueDisabled(false);
        const next = index + 1;
        persistCursor(steps[next]!.id);
        setIndex(next);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Something went wrong. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    continueDisabled,
    isLast,
    finish,
    index,
    steps,
    persistCursor,
    setIndex,
  ]);

  const handleBack = useCallback(() => {
    if (busy || continueDisabled || index === 0) return;
    handleRef.current = null;
    setContinueLabel(null);
    setContinueDisabled(false);
    const prev = index - 1;
    persistCursor(steps[prev]!.id);
    setIndex(prev);
  }, [busy, continueDisabled, index, steps, persistCursor, setIndex]);

  const handleFinishLater = useCallback(() => {
    if (busy || continueDisabled) return;
    // Not the same as finishing: record where we are and that it was dismissed,
    // WITHOUT marking onboarding complete. The checklist keeps nudging and the
    // user can resume from here later.
    utils.settings.getOnboardingState.setData(undefined, (prev) =>
      prev ? { ...prev, journeyStepId: step.id, journeyDismissed: true } : prev,
    );
    setJourneyProgress.mutate({ stepId: step.id, dismissed: true });
    setIndex(null);
  }, [busy, continueDisabled, step.id, utils, setJourneyProgress, setIndex]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Make it yours setup"
      className="fixed inset-0 z-[80] overflow-y-auto bg-[linear-gradient(135deg,#fff7ed_0%,#fdf2f8_45%,#ecfdf5_100%)] p-4 text-slate-950 sm:p-6"
    >
      <div className="flex min-h-full items-center justify-center">
        <div className="w-full max-w-2xl rounded-2xl border border-white/80 bg-white p-6 shadow-xl shadow-rose-200/30 sm:p-8">
          {/* Brand mark + progress */}
          <div className="flex items-center justify-between gap-4">
            <div className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700">
              <PawPrint className="h-4 w-4" />
              Make it yours
            </div>
            <span className="text-xs font-medium text-slate-500">
              Step {index + 1} of {total}
            </span>
          </div>

          <div className="mt-3 flex gap-1.5" aria-hidden="true">
            {steps.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  "h-1.5 flex-1 rounded-full transition-colors",
                  i <= index ? "bg-emerald-500" : "bg-slate-200",
                )}
              />
            ))}
          </div>

          {/* Title */}
          <h2 className="mt-6 font-heading text-2xl font-bold tracking-tight text-slate-950">
            {step.title}
          </h2>

          {/* Active step */}
          <div className="mt-5">
            {step.id === "intent" ? (
              <ChoosePathStep
                register={register}
                state={state}
                setState={setState}
              />
            ) : null}
            {step.id === "basics" ? (
              <PracticeBasicsStep register={register} />
            ) : null}
            {step.id === "branding" ? (
              <BrandingStep register={register} />
            ) : null}
            {step.id === "team" ? <InviteTeamStep register={register} /> : null}
            {step.id === "data" ? (
              <BringDataStep
                register={register}
                state={state}
                setState={setState}
              />
            ) : null}
            {step.id === "agent" ? <TryAgentStep register={register} /> : null}
            {step.id === "phone" ? (
              <SetUpTextingStep register={register} />
            ) : null}
            {step.id === "billing" ? (
              <AddACardStep register={register} />
            ) : null}
            {step.id === "allSet" ? (
              <AllSetStep
                register={register}
                state={state}
                setState={setState}
              />
            ) : null}
          </div>

          {/* Footer */}
          <div className="mt-8 flex items-center justify-between gap-4 border-t border-slate-100 pt-5">
            <div className="flex items-center gap-3">
              {index > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleBack}
                  disabled={busy || continueDisabled}
                >
                  <ArrowLeft className="mr-1.5 h-4 w-4" />
                  Back
                </Button>
              ) : null}
              {!isLast ? (
                <button
                  type="button"
                  onClick={handleFinishLater}
                  disabled={busy || continueDisabled}
                  className="text-sm font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
                >
                  I&apos;ll finish later
                </button>
              ) : null}
            </div>

            <Button
              type="button"
              onClick={handleContinue}
              disabled={busy || continueDisabled}
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {isLast ? "Finish" : (continueLabel ?? "Continue")}
              {!isLast && !busy ? (
                <ArrowRight className="ml-2 h-4 w-4" />
              ) : null}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
