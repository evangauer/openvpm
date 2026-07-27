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
import { buildTourSteps } from "./tour-steps";
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
import { findTourAnchor, useAnchorRect } from "./use-tour-anchor";
import { Coachmark } from "./coachmark";

/**
 * Walk from `from` in direction `dir`, passing over steps whose required
 * anchor is not in the DOM right now (e.g. the AI reply beat when the user
 * skipped sending). Can return -1 or steps.length when nothing is showable.
 */
function nextShowable(steps: GuideStep[], from: number, dir: 1 | -1): number {
  let i = from;
  while (i >= 0 && i < steps.length) {
    const s = steps[i]!;
    if (s.requiresAnchor && s.anchor && !findTourAnchor(s.anchor)) i += dir;
    else break;
  }
  return i;
}

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
  // Context for the deep tour (real chart, real bill, live agent finale).
  // Both queries are cached app-wide, so this adds no extra traffic.
  const welcomeCtx = trpc.settings.welcomeContext.useQuery(undefined, {
    enabled: isAdmin,
    staleTime: 5 * 60_000,
  });
  const agentStatus = trpc.agent.status.useQuery(undefined, {
    enabled: isAdmin,
    staleTime: 5 * 60_000,
  });

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
        onboardingIntent: prev?.onboardingIntent ?? null,
        onboardingIntentSelectedAt:
          prev?.onboardingIntentSelectedAt ?? null,
        tourStatus: status,
        lastStepId: stepId ?? prev?.lastStepId ?? null,
        setupDismissed: prev?.setupDismissed ?? false,
      }));
      setTourStatus.mutate({ status, lastStepId: stepId ?? null });
    },
    [isAdmin, setTourStatus, utils]
  );

  // Warm every route a guide will visit so each Next paints immediately
  // instead of waiting on an unprefetched navigation.
  const prefetchSteps = useCallback(
    (steps: GuideStep[]) => {
      for (const s of steps) {
        if (s.route) router.prefetch(s.route.split("?")[0]!);
      }
    },
    [router]
  );

  const start = useCallback(
    (recipe: GuideId = "tour", ctx: GuideContext = {}) => {
      if (recipe === "tour") {
        if (!isAdmin) return;
        // Context-aware: with sample data the tour walks into a real chart
        // and a real bill, and ends on the AI helper answering a question.
        // Callers may pass context; anything missing fills from the cached
        // welcome context so every entry point gets the deep tour.
        const steps = buildTourSteps({
          demoPatientName:
            ctx.demoPatientName ?? welcomeCtx.data?.demoPatientName,
          demoPatientId: welcomeCtx.data?.demoPatientId,
          demoInvoiceId: welcomeCtx.data?.demoInvoiceId,
          agentConfigured:
            ctx.agentConfigured ?? agentStatus.data?.configured,
        });
        prefetchSteps(steps);
        setRun({ recipe, steps, index: 0 });
        persist("in_progress", steps[0]!.id);
        return;
      }
      const steps = buildGuideSteps(recipe, ctx);
      if (steps.length === 0) return;
      prefetchSteps(steps);
      setRun({ recipe, steps, index: 0 });
    },
    [isAdmin, persist, prefetchSteps, welcomeCtx.data, agentStatus.data]
  );

  // Start ONLY on an explicit ?tour=start deep-link. Onboarding is opt-in: a
  // not-yet-started workspace is no longer auto-nagged into the tour — the
  // welcome surface and activation checklist invoke start() on demand instead.
  useEffect(() => {
    if (autoStarted.current || run !== null || !isAdmin) return;
    // Wait for the tour context to settle so the deep-link never races into
    // the shallow fallback steps (fetch errors still start the fallback).
    if (welcomeCtx.isLoading || agentStatus.isLoading) return;
    const wantStart =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("tour") === "start";
    if (wantStart) {
      autoStarted.current = true;
      router.replace(pathname); // strip the param so a refresh won't relaunch
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, stateQuery.data, pathname, run, welcomeCtx.isLoading, agentStatus.isLoading]);

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
      const next = nextShowable(r.steps, r.index + 1, 1);
      if (next >= r.steps.length) {
        if (r.recipe === "tour") {
          persist("completed");
        } else {
          markGuideCompleted(userId, r.recipe);
          emitGuideCompleted(r.recipe);
        }
        return null;
      }
      // Navigate WITH the step change (not as a trailing effect) so rapid
      // Next clicks always land on the newest step's route.
      const nextStep = r.steps[next]!;
      if (nextStep.route) router.push(nextStep.route);
      if (r.recipe === "tour") persist("in_progress", nextStep.id);
      return { ...r, index: next };
    });
  }, [persist, router, userId]);

  const onBack = useCallback(
    () =>
      setRun((r) => {
        if (!r || r.index <= 0) return r;
        const prev = nextShowable(r.steps, r.index - 1, -1);
        if (prev < 0) return r;
        const prevStep = r.steps[prev]!;
        if (prevStep.route) router.push(prevStep.route);
        return { ...r, index: prev };
      }),
    [router]
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
