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
import { ArrowLeft, ArrowRight, Loader2, PawPrint } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { firstRunMode } from "@/lib/welcome/first-run";
import {
  DEFAULT_ONBOARDING_INTENT,
  type OnboardingIntent,
} from "@/lib/onboarding/intent";
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
    // offer, activation checklist). NEXT_PUBLIC_FIRST_RUN_MODE=wizard
    // restores this auto-open exactly.
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
  initialMigrationHasCommittedChanges,
  initialMigrationSource,
  initialMigrationSourceHasCommittedChanges,
  initialMigrationCompletedModes,
}: {
  steps: readonly OnboardingJourneyStep[];
  index: number;
  setIndex: (i: number | null) => void;
  initialIntent: OnboardingIntent;
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
    setIndex(null);
    router.push(
      state.hasImportedData
        ? "/schedule?setup=first-visit"
        : "/clients/new?setup=first-visit",
    );
  }, [
    completeOnboarding,
    clearDemoData,
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-[80] bg-[linear-gradient(135deg,#fff7ed_0%,#fdf2f8_45%,#ecfdf5_100%)]" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-[80] overflow-y-auto p-4 text-slate-950 outline-none sm:p-6"
          onInteractOutside={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <DialogPrimitive.Description className="sr-only">
            Guided setup for your OpenVPM clinic.
          </DialogPrimitive.Description>
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
              <DialogPrimitive.Title asChild>
                <h2 className="mt-6 font-heading text-2xl font-bold tracking-tight text-slate-950">
                  {step.title}
                </h2>
              </DialogPrimitive.Title>

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

              {/* Footer */}
              <div className="mt-8 flex flex-col-reverse items-stretch gap-4 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-2">
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
                    ) : null}
                    {!isLast ? (
                      <button
                        type="button"
                        onClick={handleFinishLater}
                        disabled={busy || continueDisabled}
                        className="text-sm font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
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
                  className="h-auto min-h-10 w-full whitespace-normal py-2 text-center sm:w-auto"
                >
                  {busy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  {continueLabel ?? (isLast ? "Finish" : "Continue")}
                  {!busy ? <ArrowRight className="ml-2 h-4 w-4" /> : null}
                </Button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
