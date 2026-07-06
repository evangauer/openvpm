"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { useSession } from "next-auth/react";
import { ArrowLeft, ArrowRight, Loader2, PawPrint } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { JourneyState, StepHandle } from "./journey-types";
import { PracticeBasicsStep } from "./steps/practice-basics";
import { BrandingStep } from "./steps/branding";
import { InviteTeamStep } from "./steps/invite-team";
import { BringDataStep } from "./steps/bring-data";
import { TryAgentStep } from "./steps/try-agent";

const STEPS = [
  { id: "basics", title: "Tell us about your clinic." },
  { id: "branding", title: "Make it feel like yours." },
  { id: "team", title: "Bring your team in." },
  { id: "data", title: "Add your real clients and pets." },
  { id: "agent", title: "Try your AI helper." },
] as const;

const TOTAL = STEPS.length;

interface OnboardingJourneyContextValue {
  /** Open the "Make it yours" guided setup from the first step. */
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
 * Provides the "Make it yours" guided setup as an OPT-IN overlay. It no longer
 * auto-opens after the tour — onboarding is opt-in now, so the welcome panel and
 * activation checklist invoke `openJourney()` explicitly. Mount once in the
 * dashboard layout, wrapping the content so consumers can open it. Each step
 * runs its own server work on Continue; finishing marks onboarding complete (and
 * clears the sample data unless the user chose to keep it).
 */
export function OnboardingJourneyProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, status } = useSession();
  const isAdmin =
    status === "authenticated" && session?.user?.role === "admin";
  // null = closed; a number is the active step index.
  const [index, setIndex] = useState<number | null>(null);
  const openJourney = useCallback(() => {
    if (!isAdmin) return;

    setIndex(0);
  }, [isAdmin]);
  const isOpen = isAdmin && index !== null;

  return (
    <OnboardingJourneyContext.Provider
      value={{ openJourney, isOpen }}
    >
      {children}
      {isOpen ? <JourneyShell index={index!} setIndex={setIndex} /> : null}
    </OnboardingJourneyContext.Provider>
  );
}

/**
 * The mounted overlay. Split out so its hooks only run while the journey is
 * actually open, and the step index lives in the parent for the open-once guard.
 */
function JourneyShell({
  index,
  setIndex,
}: {
  index: number;
  setIndex: (i: number | null) => void;
}) {
  const utils = trpc.useUtils();
  const completeOnboarding = trpc.settings.completeOnboarding.useMutation();
  const clearDemoData = trpc.settings.clearDemoData.useMutation();

  // Default to keeping the sample data; the "Add your data" step changes this
  // when the user chooses to import real data or connect later by API.
  const [state, setStateRaw] = useState<JourneyState>({
    keepSampleData: true,
  });
  const setState = useCallback(
    (patch: Partial<JourneyState>) =>
      setStateRaw((prev) => ({ ...prev, ...patch })),
    []
  );

  // The active step registers its Continue handler here.
  const handleRef = useRef<StepHandle | null>(null);
  const register = useCallback((h: StepHandle) => {
    handleRef.current = h;
  }, []);

  const [busy, setBusy] = useState(false);
  const step = STEPS[index]!;
  const isLast = index >= TOTAL - 1;

  const finish = useCallback(async () => {
    await completeOnboarding.mutateAsync();
    if (!state.keepSampleData) {
      try {
        await clearDemoData.mutateAsync();
      } catch {
        // Clearing sample data is best-effort; never block finishing on it.
      }
    }
    // Refresh both gates so the overlay closes and never reopens.
    await Promise.all([
      utils.settings.onboardingStatus.invalidate(),
      utils.settings.getOnboardingState.invalidate(),
    ]);
    setIndex(null);
  }, [completeOnboarding, clearDemoData, state.keepSampleData, utils, setIndex]);

  const handleContinue = useCallback(async () => {
    if (busy) return;
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
        setIndex(index + 1);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Something went wrong. Try again."
      );
    } finally {
      setBusy(false);
    }
  }, [busy, isLast, finish, index, setIndex]);

  const handleBack = useCallback(() => {
    if (busy || index === 0) return;
    handleRef.current = null;
    setIndex(index - 1);
  }, [busy, index, setIndex]);

  const handleSkip = useCallback(async () => {
    if (busy) return;
    // Skip ends the whole setup: mark it done so it never reopens.
    setBusy(true);
    try {
      await finish();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Something went wrong. Try again."
      );
    } finally {
      setBusy(false);
    }
  }, [busy, finish]);

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
              Step {index + 1} of {TOTAL}
            </span>
          </div>

          <div className="mt-3 flex gap-1.5" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  "h-1.5 flex-1 rounded-full transition-colors",
                  i <= index ? "bg-emerald-500" : "bg-slate-200"
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
            {step.id === "basics" ? (
              <PracticeBasicsStep register={register} />
            ) : null}
            {step.id === "branding" ? (
              <BrandingStep register={register} />
            ) : null}
            {step.id === "team" ? (
              <InviteTeamStep register={register} />
            ) : null}
            {step.id === "data" ? (
              <BringDataStep register={register} setState={setState} />
            ) : null}
            {step.id === "agent" ? (
              <TryAgentStep register={register} />
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
                  disabled={busy}
                >
                  <ArrowLeft className="mr-1.5 h-4 w-4" />
                  Back
                </Button>
              ) : null}
              <button
                type="button"
                onClick={handleSkip}
                disabled={busy}
                className="text-sm font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50"
              >
                Skip for now
              </button>
            </div>

            <Button type="button" onClick={handleContinue} disabled={busy}>
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {isLast ? "Finish" : "Continue"}
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
