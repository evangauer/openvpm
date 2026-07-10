"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc";
import type { GuideId } from "@/lib/welcome/cards";
import { markGuideCompleted } from "@/lib/welcome/local-state";
import { TOUR_STEPS } from "./tour-steps";
import {
  buildGuideSteps,
  type GuideContext,
  type GuideStep,
} from "./guide-recipes";
import {
  emitGuideCompleted,
  GUIDE_SIGNAL_EVENT,
  guideSignalName,
} from "./guide-signals";
import { useAnchorRect } from "./use-tour-anchor";
import { Coachmark } from "./coachmark";

interface TourContextValue {
  /**
   * Start a guide from its first step. No recipe id = the classic value tour
   * (admin-only, persisted server-side). Named guides are open to all staff
   * and record completion per user on this device.
   */
  start: (recipe?: GuideId, ctx?: GuideContext) => void;
  isActive: boolean;
  /** Which guide is running, or null. */
  activeGuide: GuideId | null;
}

const TourContext = createContext<TourContextValue>({
  start: () => {},
  isActive: false,
  activeGuide: null,
});

export function useTour() {
  return useContext(TourContext);
}

interface ActiveRun {
  recipe: GuideId;
  steps: GuideStep[];
  index: number;
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const isAdmin =
    status === "authenticated" && session?.user?.role === "admin";
  const userId = session?.user?.id ?? null;

  const utils = trpc.useUtils();
  const stateQuery = trpc.settings.getOnboardingState.useQuery(undefined, {
    enabled: isAdmin,
  });
  const setTourStatus = trpc.settings.setTourStatus.useMutation();

  // null = no guide running; otherwise the active recipe + step cursor.
  const [run, setRun] = useState<ActiveRun | null>(null);
  // Auto-start runs at most once per mount, so finishing/skipping never relaunches.
  const autoStarted = useRef(false);

  // Server persistence exists only for the classic tour; named guides record
  // completion in per-user local state instead (viewers cannot mutate).
  const persist = useCallback(
    (status: "in_progress" | "completed" | "skipped", stepId?: string) => {
      if (!isAdmin) return;

      // Keep the cached onboarding state in sync so the auto-start effect never
      // re-reads a stale "not_started" after a terminal status.
      utils.settings.getOnboardingState.setData(undefined, (prev) => ({
        journeyStepId: prev?.journeyStepId ?? null,
        journeyDismissed: prev?.journeyDismissed ?? false,
        ...prev,
        tourStatus: status,
        lastStepId: stepId ?? prev?.lastStepId ?? null,
        setupDismissed: prev?.setupDismissed ?? false,
      }));
      setTourStatus.mutate({ status, lastStepId: stepId ?? null });
    },
    [isAdmin, setTourStatus, utils]
  );

  const start = useCallback(
    (recipe: GuideId = "tour", ctx: GuideContext = {}) => {
      if (recipe === "tour") {
        if (!isAdmin) return;
        setRun({ recipe, steps: TOUR_STEPS, index: 0 });
        persist("in_progress", TOUR_STEPS[0]!.id);
        return;
      }
      const steps = buildGuideSteps(recipe, ctx);
      if (steps.length === 0) return;
      setRun({ recipe, steps, index: 0 });
    },
    [isAdmin, persist]
  );

  // Start ONLY on an explicit ?tour=start deep-link. Onboarding is opt-in: a
  // not-yet-started workspace is no longer auto-nagged into the tour — the
  // welcome surface and activation checklist invoke start() on demand instead.
  useEffect(() => {
    if (autoStarted.current || run !== null || !isAdmin) return;
    const wantStart =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("tour") === "start";
    if (wantStart) {
      autoStarted.current = true;
      router.replace(pathname); // strip the param so a refresh won't relaunch
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, stateQuery.data, pathname, run]);

  const step = run ? run.steps[run.index] ?? null : null;

  // Navigate to the step's route when the step changes. Routes may carry a
  // one-shot query string (e.g. /agent?ask=...); compare on the path only.
  useEffect(() => {
    if (!step?.route) return;
    const routePath = step.route.split("?")[0]!;
    if (pathname !== routePath) router.push(step.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.index, run?.recipe]);

  const onNext = useCallback(() => {
    setRun((r) => {
      if (!r) return r;
      if (r.index >= r.steps.length - 1) {
        if (r.recipe === "tour") {
          persist("completed");
        } else {
          markGuideCompleted(userId, r.recipe);
          emitGuideCompleted(r.recipe);
        }
        return null;
      }
      if (r.recipe === "tour") persist("in_progress", r.steps[r.index + 1]!.id);
      return { ...r, index: r.index + 1 };
    });
  }, [persist, userId]);

  const onBack = useCallback(
    () =>
      setRun((r) => (r && r.index > 0 ? { ...r, index: r.index - 1 } : r)),
    []
  );

  const onSkip = useCallback(() => {
    setRun((r) => {
      if (r?.recipe === "tour") persist("skipped");
      return null;
    });
  }, [persist]);

  // Auto-advance the active step when product code emits its signal (e.g. an
  // agent run succeeded, a portal link was copied). Next still works, so a
  // missing signal never strands anyone.
  const advanceOn = step?.advanceOn;
  useEffect(() => {
    if (!advanceOn || typeof window === "undefined") return;
    const onSignal = (event: Event) => {
      if (guideSignalName(event) === advanceOn) onNext();
    };
    window.addEventListener(GUIDE_SIGNAL_EVENT, onSignal);
    return () => window.removeEventListener(GUIDE_SIGNAL_EVENT, onSignal);
  }, [advanceOn, onNext]);

  const rect = useAnchorRect(step?.anchor, run?.index);

  const total = run?.steps.length ?? 0;

  return (
    <TourContext.Provider
      value={{ start, isActive: run !== null, activeGuide: run?.recipe ?? null }}
    >
      {children}
      {run && step ? (
        <Coachmark
          rect={step.anchor ? rect : null}
          step={step}
          index={run.index}
          total={total}
          onNext={onNext}
          onBack={onBack}
          onSkip={onSkip}
        />
      ) : null}
    </TourContext.Provider>
  );
}
