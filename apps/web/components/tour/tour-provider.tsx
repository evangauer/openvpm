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
import { TOUR_STEPS } from "./tour-steps";
import { useAnchorRect } from "./use-tour-anchor";
import { Coachmark } from "./coachmark";

interface TourContextValue {
  /** Manually (re)start the tour from the beginning. */
  start: () => void;
  isActive: boolean;
}

const TourContext = createContext<TourContextValue>({
  start: () => {},
  isActive: false,
});

export function useTour() {
  return useContext(TourContext);
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const isAdmin =
    status === "authenticated" && session?.user?.role === "admin";

  const utils = trpc.useUtils();
  const stateQuery = trpc.settings.getOnboardingState.useQuery(undefined, {
    enabled: isAdmin,
  });
  const setTourStatus = trpc.settings.setTourStatus.useMutation();

  // null = tour inactive; otherwise the active step index.
  const [index, setIndex] = useState<number | null>(null);
  // Auto-start runs at most once per mount, so finishing/skipping never relaunches.
  const autoStarted = useRef(false);

  const persist = useCallback(
    (status: "in_progress" | "completed" | "skipped", stepId?: string) => {
      // Keep the cached onboarding state in sync so the auto-start effect never
      // re-reads a stale "not_started" after a terminal status.
      utils.settings.getOnboardingState.setData(undefined, (prev) => ({
        tourStatus: status,
        lastStepId: stepId ?? prev?.lastStepId ?? null,
        setupDismissed: prev?.setupDismissed ?? false,
      }));
      setTourStatus.mutate({ status, lastStepId: stepId ?? null });
    },
    [setTourStatus, utils]
  );

  const start = useCallback(() => {
    setIndex(0);
    persist("in_progress", TOUR_STEPS[0]!.id);
  }, [persist]);

  // Start ONLY on an explicit ?tour=start deep-link. Onboarding is opt-in: a
  // not-yet-started workspace is no longer auto-nagged into the tour — the
  // welcome panel and activation checklist invoke start() on demand instead.
  useEffect(() => {
    if (autoStarted.current || index !== null || !isAdmin) return;
    const wantStart =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("tour") === "start";
    if (wantStart) {
      autoStarted.current = true;
      router.replace(pathname); // strip the param so a refresh won't relaunch
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, stateQuery.data, pathname, index]);

  const step = index !== null ? TOUR_STEPS[index] : null;

  // Navigate to the step's route when the step changes.
  useEffect(() => {
    if (!step?.route) return;
    if (pathname !== step.route) router.push(step.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const rect = useAnchorRect(step?.anchor, index);

  const total = TOUR_STEPS.length;

  const onNext = useCallback(() => {
    setIndex((i) => {
      if (i === null) return i;
      if (i >= total - 1) {
        persist("completed");
        return null;
      }
      persist("in_progress", TOUR_STEPS[i + 1]!.id);
      return i + 1;
    });
  }, [persist, total]);

  const onBack = useCallback(
    () => setIndex((i) => (i && i > 0 ? i - 1 : i)),
    []
  );

  const onSkip = useCallback(() => {
    persist("skipped");
    setIndex(null);
  }, [persist]);

  return (
    <TourContext.Provider value={{ start, isActive: index !== null }}>
      {children}
      {step ? (
        <Coachmark
          rect={step.anchor ? rect : null}
          step={step}
          index={index!}
          total={total}
          onNext={onNext}
          onBack={onBack}
          onSkip={onSkip}
        />
      ) : null}
    </TourContext.Provider>
  );
}
