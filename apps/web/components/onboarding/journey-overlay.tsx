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
import { useRouter } from "next/navigation";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowLeft, ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { BrandBadge } from "@/components/brand/paw-mark";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { firstRunMode } from "@/lib/welcome/first-run";
import { FUNNEL_EVENTS } from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";
import {
  DEFAULT_ONBOARDING_INTENT,
  type OnboardingIntent,
} from "@/lib/onboarding/intent";
import {
  DEFAULT_CLINIC_MODEL,
  DEFAULT_FIRST_GOAL,
  type ClinicModel,
  type FirstGoal,
} from "@/lib/onboarding/clinic-profile";
import type { JourneyState, StepHandle } from "./journey-types";
import {
  ONBOARDING_JOURNEY_STEPS,
  onboardingJourneyResumeIndex,
  type OnboardingJourneyStep,
} from "@/lib/onboarding/journey-plan";
import { ChoosePathStep } from "./steps/choose-path";
import { PracticeBasicsStep } from "./steps/practice-basics";
import { BringDataStep } from "./steps/bring-data";
import { AllSetStep } from "./steps/all-set";

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
 * keep it), then routes directly to the next real clinic action.
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
  const steps = ONBOARDING_JOURNEY_STEPS;

  const journeyStepId = onboardingState.data?.journeyStepId ?? null;
  const onboardingIntent = onboardingState.data?.onboardingIntent ?? null;
  const resumeIndex = useMemo(() => {
    return onboardingJourneyResumeIndex({
      onboardingIntent,
      journeyStepId,
      migrationHasCommittedChanges:
        onboardingState.data?.migrationHasCommittedChanges === true,
    });
  }, [journeyStepId, onboardingIntent, onboardingState.data]);

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
    if (!onboardingState.data) return;
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
    // offer, activation checklist). The personalized builder is the default;
    // NEXT_PUBLIC_FIRST_RUN_MODE=welcome remains the rollback path.
    if (firstRunMode() === "welcome") return;
    // Wait until the setup state is loaded so the resume point is stable.
    if (!onboardingStatus.data || !onboardingState.data) {
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
          initialClinicModel={
            (onboardingState.data?.clinicModel as ClinicModel | null) ??
            DEFAULT_CLINIC_MODEL
          }
          initialFirstGoal={
            (onboardingState.data?.firstGoal as FirstGoal | null) ??
            DEFAULT_FIRST_GOAL
          }
          initialMigrationHasCommittedChanges={
            onboardingState.data?.migrationHasCommittedChanges === true
          }
          initialMigrationSource={onboardingState.data?.migrationSource ?? null}
          initialMigrationSourceHasCommittedChanges={
            onboardingState.data?.migrationSourceHasCommittedChanges === true
          }
          initialMigrationCompletedModes={
            onboardingState.data?.migrationCompletedModes ?? []
          }
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
  initialClinicModel,
  initialFirstGoal,
  initialMigrationHasCommittedChanges,
  initialMigrationSource,
  initialMigrationSourceHasCommittedChanges,
  initialMigrationCompletedModes,
}: {
  steps: readonly OnboardingJourneyStep[];
  index: number;
  setIndex: (i: number | null) => void;
  initialIntent: OnboardingIntent;
  initialClinicModel: ClinicModel;
  initialFirstGoal: FirstGoal;
  initialMigrationHasCommittedChanges: boolean;
  initialMigrationSource: JourneyState["migrationSource"];
  initialMigrationSourceHasCommittedChanges: boolean;
  initialMigrationCompletedModes: NonNullable<
    JourneyState["migrationCompletedModes"]
  >;
}) {
  const utils = trpc.useUtils();
  const router = useRouter();
  const completeOnboarding = trpc.settings.completeOnboarding.useMutation();
  const clearDemoData = trpc.settings.clearDemoData.useMutation();
  const setJourneyProgress = trpc.settings.setJourneyProgress.useMutation();

  // Shared step state. Real imports replace sample data; otherwise the clinic
  // can keep the sample records while it adds its first real client.
  const [state, setStateRaw] = useState<JourneyState>({
    clinicModel: initialClinicModel,
    firstGoal: initialFirstGoal,
    onboardingIntent: initialIntent,
    keepSampleData: !initialMigrationHasCommittedChanges,
    hasPartialImport: false,
    hasImportedData: initialMigrationHasCommittedChanges,
    migrationSource: initialMigrationSource,
    migrationSourceHasCommittedChanges:
      initialMigrationSourceHasCommittedChanges,
    migrationCompletedModes: initialMigrationCompletedModes,
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

  useEffect(() => {
    trackFunnelEvent(FUNNEL_EVENTS.onboardingStepViewed, {
      model: state.clinicModel,
      goal: state.firstGoal,
      step: step.id,
    });
  }, [state.clinicModel, state.firstGoal, step.id]);

  // Do not advance or close until the server accepts the cursor. A local-only
  // optimistic cursor can strand a clinic at an earlier step after a reload.
  const persistCursor = useCallback(
    async (stepId: string, dismissed?: boolean) => {
      await setJourneyProgress.mutateAsync({ stepId, dismissed });
      utils.settings.getOnboardingState.setData(undefined, (prev) =>
        prev
          ? {
              ...prev,
              journeyStepId: stepId,
              ...(dismissed === undefined
                ? {}
                : { journeyDismissed: dismissed }),
            }
          : prev,
      );
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
    trackFunnelEvent(FUNNEL_EVENTS.onboardingCompleted, {
      model: state.clinicModel,
      goal: state.firstGoal,
      step: "allSet",
    });
    trackFunnelEvent(FUNNEL_EVENTS.firstActionSelected, {
      goal: state.firstGoal,
      placement: state.hasImportedData ? "schedule" : "client",
      step: "first_action",
    });
    setIndex(null);
    router.push(
      state.hasImportedData
        ? "/schedule?setup=first-visit"
        : "/clients/new?setup=first-visit",
    );
  }, [
    completeOnboarding,
    clearDemoData,
    state.clinicModel,
    state.firstGoal,
    state.keepSampleData,
    state.hasImportedData,
    utils,
    setIndex,
    router,
  ]);

  const handleContinue = useCallback(async () => {
    if (busy || continueDisabled) return;
    setBusy(true);
    try {
      const advance = handleRef.current
        ? await handleRef.current.onContinue()
        : true;
      if (!advance) return;
      trackFunnelEvent(FUNNEL_EVENTS.onboardingStepCompleted, {
        model: state.clinicModel,
        goal: state.firstGoal,
        step: step.id,
      });
      if (isLast) {
        await finish();
      } else {
        handleRef.current = null;
        setContinueLabel(null);
        setContinueDisabled(false);
        const next = index + 1;
        await persistCursor(steps[next]!.id, false);
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
    state.clinicModel,
    state.firstGoal,
    step.id,
    steps,
    persistCursor,
    setIndex,
  ]);

  const handleBack = useCallback(async () => {
    if (busy || continueDisabled || state.hasPartialImport || index === 0)
      return;
    setBusy(true);
    try {
      const prev = index - 1;
      await persistCursor(steps[prev]!.id, false);
      handleRef.current = null;
      setContinueLabel(null);
      setContinueDisabled(false);
      setIndex(prev);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Progress could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    continueDisabled,
    state.hasPartialImport,
    index,
    steps,
    persistCursor,
    setIndex,
  ]);

  const handleFinishLater = useCallback(async () => {
    if (busy || continueDisabled) return;
    // Not the same as finishing: record where we are and that it was dismissed,
    // WITHOUT marking onboarding complete. The checklist keeps nudging and the
    // user can resume from here later.
    setBusy(true);
    try {
      await persistCursor(step.id, true);
      setIndex(null);
      if (state.hasPartialImport) {
        toast.success(
          "Completed records are saved. Reopen setup or use Settings, then Data, to finish the remaining files.",
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Progress could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    continueDisabled,
    step.id,
    state.hasPartialImport,
    persistCursor,
    setIndex,
  ]);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) void handleFinishLater();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-[linear-gradient(135deg,#fff8f5_0%,#f7f5ff_42%,#f2fbf7_100%)]" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[80] overflow-y-auto text-slate-950 outline-none sm:p-4 lg:p-6"
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogPrimitive.Description className="sr-only">
            Guided setup for your OpenVPM clinic.
          </DialogPrimitive.Description>
          <div className="flex min-h-full items-center justify-center">
            <div
              className={cn(
                "flex min-h-full w-full flex-col overflow-hidden bg-white shadow-[0_30px_90px_-38px_rgba(30,41,59,0.38)] sm:min-h-0 sm:rounded-[24px] sm:border sm:border-white/90",
                step.id === "intent"
                  ? "max-w-[1440px]"
                  : step.id === "allSet"
                    ? "max-w-5xl"
                    : "max-w-3xl",
              )}
            >
              <header className="flex items-center justify-between gap-5 border-b border-slate-100 px-5 py-4 sm:px-8 sm:py-5 lg:px-12">
                <div className="inline-flex items-center gap-2.5 text-slate-950">
                  <BrandBadge
                    className="h-9 w-9 rounded-xl"
                    pawClassName="h-5 w-5"
                  />
                  <span className="font-heading text-lg font-semibold tracking-tight">
                    OpenVPM
                  </span>
                </div>
                <div className="flex min-w-[132px] items-center gap-3 sm:min-w-[230px]">
                  <span className="shrink-0 text-xs font-medium text-slate-500">
                    Step {index + 1} of {total}
                  </span>
                  <div className="flex flex-1 gap-1.5" aria-hidden="true">
                    {steps.map((s, i) => (
                      <span
                        key={s.id}
                        className={cn(
                          "h-1.5 flex-1 rounded-full transition-colors duration-300",
                          i <= index ? "bg-primary" : "bg-slate-200",
                        )}
                      />
                    ))}
                  </div>
                </div>
              </header>

              <div
                className={cn(
                  "flex-1 px-5 py-7 sm:px-8 sm:py-9",
                  step.id === "intent" || step.id === "allSet"
                    ? "lg:px-12 lg:py-10"
                    : "lg:px-10",
                )}
              >
                <DialogPrimitive.Title asChild>
                  <h2
                    className={cn(
                      "max-w-3xl tracking-[-0.035em] text-slate-950",
                      step.id === "intent"
                        ? "font-heading text-[2.15rem] font-bold leading-[1.08] sm:text-[2.65rem] lg:text-[3rem]"
                        : "font-heading text-2xl font-bold sm:text-3xl",
                    )}
                  >
                    {step.title}
                  </h2>
                </DialogPrimitive.Title>

                <div className={step.id === "intent" ? "mt-3" : "mt-6"}>
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
                  {step.id === "data" ? (
                    <BringDataStep
                      register={register}
                      state={state}
                      setState={setState}
                    />
                  ) : null}
                  {step.id === "allSet" ? (
                    <AllSetStep register={register} state={state} />
                  ) : null}
                </div>
              </div>

              <footer className="border-t border-slate-100 bg-white px-5 py-4 sm:px-8 sm:py-5 lg:px-12">
                <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex items-center justify-between gap-3 sm:justify-start">
                      {index > 0 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={handleBack}
                          disabled={
                            busy || continueDisabled || state.hasPartialImport
                          }
                          aria-describedby={
                            state.hasPartialImport
                              ? "onboarding-back-disabled-reason"
                              : undefined
                          }
                        >
                          <ArrowLeft className="mr-1.5 h-4 w-4" />
                          Back
                        </Button>
                      ) : (
                        <span className="hidden items-center gap-2 text-xs text-slate-500 sm:flex">
                          <ShieldCheck className="h-4 w-4 text-primary" />
                          You can change this later.
                        </span>
                      )}
                      {!isLast ? (
                        <button
                          type="button"
                          onClick={handleFinishLater}
                          disabled={busy || continueDisabled}
                          className="min-h-10 rounded-lg px-2 text-sm font-medium text-slate-500 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                        >
                          {state.hasPartialImport
                            ? "Finish remaining import later"
                            : "I'll finish later"}
                        </button>
                      ) : null}
                    </div>
                    {state.hasPartialImport ? (
                      <p
                        id="onboarding-back-disabled-reason"
                        className="max-w-sm text-xs leading-5 text-slate-500"
                      >
                        Back is unavailable after records are saved. Finish the
                        remaining import now or continue it later.
                      </p>
                    ) : null}
                  </div>

                  <Button
                    type="button"
                    onClick={handleContinue}
                    disabled={busy || continueDisabled}
                    className="h-auto min-h-12 w-full whitespace-normal rounded-xl bg-primary px-6 py-3 text-center text-sm font-semibold shadow-[0_12px_24px_-14px_rgba(4,120,87,0.8)] transition hover:-translate-y-0.5 hover:bg-primary/90 sm:w-auto"
                  >
                    {busy ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {continueLabel ?? (isLast ? "Finish" : "Continue")}
                    {!busy ? <ArrowRight className="ml-2 h-4 w-4" /> : null}
                  </Button>
                </div>
              </footer>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
