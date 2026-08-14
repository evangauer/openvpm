"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { PartyPopper } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  canRunAgentGuideRole,
  visibleWelcomeCards,
  type WelcomeCardId,
} from "@/lib/welcome/cards";
import {
  markSetupOffered,
  markWelcomeSeen,
  readWelcomeState,
} from "@/lib/welcome/local-state";
import {
  firstRunMode,
  suppressWelcomeForBilling,
} from "@/lib/welcome/first-run";
import { useTour } from "@/components/tour/tour-provider";
import { useOnboardingJourney } from "@/components/onboarding/journey-overlay";
import type { GuideContext } from "@/components/tour/guide-recipes";
import {
  GUIDE_COMPLETED_EVENT,
  guideCompletedRecipe,
} from "@/components/tour/guide-signals";
import { WelcomeSurface } from "./welcome-surface";
import type { WelcomeVariant } from "./polaroid-card";
import { WELCOME_COPY } from "./welcome-copy";
import { stripDemoRoleSwitchMarker } from "@/lib/demo-role-switcher";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE?.trim() === "true";

interface WelcomeContextValue {
  openWelcome: () => void;
  isOpen: boolean;
}

const WelcomeContext = createContext<WelcomeContextValue>({
  openWelcome: () => {},
  isOpen: false,
});

export function useWelcome() {
  return useContext(WelcomeContext);
}

/**
 * Value-first first-run: before any setup is asked of a new user, show
 * what OpenVPM can do for their clinic today (the Polaroid guide cards).
 *
 * Gating:
 * - New trial admins: auto-opens under the SAME three server gates the
 *   wizard used (not finished, not dismissed, not an established
 *   practice), so exactly one of the two auto-opens per firstRunMode().
 * - Invited staff (any role): auto-opens once per user per device.
 * - Afterwards: reachable from Guides in the sidebar, or ?guides=1.
 */
export function WelcomeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const authed = status === "authenticated";
  const role = session?.user?.role ?? null;
  const userId = session?.user?.id ?? null;
  const isAdmin = authed && role === "admin";
  const welcomeMode = firstRunMode() === "welcome";

  const { start } = useTour();
  const { openJourney } = useOnboardingJourney();

  const onboardingStatus = trpc.settings.onboardingStatus.useQuery(undefined, {
    enabled: isAdmin,
  });
  const onboardingState = trpc.settings.getOnboardingState.useQuery(undefined, {
    enabled: isAdmin,
  });
  const welcomeContext = trpc.settings.welcomeContext.useQuery(undefined, {
    enabled: authed,
  });
  const agentStatus = trpc.agent.status.useQuery(undefined, {
    enabled: authed && canRunAgentGuideRole(role),
  });

  const [open, setOpen] = useState(false);
  const [setupOfferOpen, setSetupOfferOpen] = useState(false);
  // Auto-open decides at most once per mount; finishing/skipping never re-nags.
  const autoDecided = useRef(false);
  // Captured at mount: the ?guides=1 strip below rewrites the URL, which
  // would otherwise drop ?welcomeVariant before the surface reads it.
  const [variant] = useState<WelcomeVariant>(resolveVariant);

  // Manual open (sidebar Guides) works regardless of first-run mode.
  const openWelcome = useCallback(() => {
    if (!authed) return;
    setSetupOfferOpen(false);
    setOpen(true);
  }, [authed]);

  // Auto-open + ?guides=1 deep link.
  useEffect(() => {
    if (autoDecided.current || open || !authed || !userId) return;

    const wantGuides =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("guides") === "1";

    if (DEMO_MODE && typeof window !== "undefined") {
      const roleSwitchLanding = stripDemoRoleSwitchMarker(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      );
      if (roleSwitchLanding.hadMarker) {
        autoDecided.current = true;
        router.replace(roleSwitchLanding.path);
        return;
      }
    }

    if (wantGuides) {
      autoDecided.current = true;
      router.replace(pathname); // strip so refresh does not relaunch
      setOpen(true);
      return;
    }

    if (
      typeof window !== "undefined" &&
      suppressWelcomeForBilling(
        pathname,
        new URLSearchParams(window.location.search),
      )
    ) {
      autoDecided.current = true;
      return;
    }

    if (!welcomeMode) return;
    if (readWelcomeState(userId).seenAt) {
      autoDecided.current = true;
      return;
    }
    if (isAdmin) {
      // Wait for the same gates the wizard used, so the two first-run
      // surfaces can never both fire.
      if (!onboardingStatus.data || !onboardingState.data) return;
      const notFinished = onboardingStatus.data.completedAt == null;
      const dismissed = onboardingState.data.journeyDismissed === true;
      const established = onboardingStatus.data.establishedPractice === true;
      autoDecided.current = true;
      if (!(notFinished && !dismissed && !established)) return;
      setOpen(true);
      return;
    }
    // Invited staff get greeted once, no admin-only queries involved.
    autoDecided.current = true;
    setOpen(true);
  }, [
    authed,
    userId,
    isAdmin,
    open,
    welcomeMode,
    onboardingStatus.data,
    onboardingState.data,
    pathname,
    router,
  ]);

  // After a guide finishes, return to the cards so the next one is one click
  // away. Only when an admin mid-onboarding has tried every visible card do
  // we offer setup, once; the docked checklist keeps a standing path to it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onCompleted = (event: Event) => {
      const recipe = guideCompletedRecipe(event);
      if (!recipe || recipe === "tour") return;
      const state = readWelcomeState(userId);
      const done = new Set(Object.keys(state.guides ?? {}));
      const allDone = visibleWelcomeCards({ role }).every((c) => done.has(c));
      const offerSetup =
        isAdmin &&
        onboardingStatus.data?.completedAt == null &&
        allDone &&
        !state.setupOfferedAt;
      if (offerSetup) {
        markSetupOffered(userId);
        setSetupOfferOpen(true);
      } else {
        setOpen(true);
      }
    };
    window.addEventListener(GUIDE_COMPLETED_EVENT, onCompleted);
    return () => window.removeEventListener(GUIDE_COMPLETED_EVENT, onCompleted);
  }, [isAdmin, onboardingStatus.data, userId, role]);

  const startGuide = useCallback(
    (card: WelcomeCardId, ctx: GuideContext) => {
      markWelcomeSeen(userId);
      setOpen(false);
      start(card, ctx);
    },
    [start, userId],
  );

  const skip = useCallback(() => {
    markWelcomeSeen(userId);
    setOpen(false);
  }, [userId]);

  const setupInstead = useCallback(() => {
    markWelcomeSeen(userId);
    setOpen(false);
    openJourney();
  }, [openJourney, userId]);

  const guideContext: GuideContext = {
    portalClient: welcomeContext.data?.portalClient ?? null,
    demoPatientName: welcomeContext.data?.demoPatientName ?? null,
    agentConfigured: agentStatus.data?.configured,
  };

  const headline = isAdmin
    ? WELCOME_COPY.headlineAdmin(
        welcomeContext.data?.practiceName ?? "your clinic",
      )
    : session?.user?.name
      ? WELCOME_COPY.headlineStaff(session.user.name.split(" ")[0]!)
      : WELCOME_COPY.headlineFallback;

  const completed = new Set(Object.keys(readWelcomeState(userId).guides ?? {}));

  return (
    <WelcomeContext.Provider value={{ openWelcome, isOpen: open }}>
      {children}
      {open && authed ? (
        <WelcomeSurface
          headline={headline}
          cards={visibleWelcomeCards({ role })}
          completed={completed}
          variant={variant}
          guideContext={guideContext}
          showSetupLink={isAdmin && onboardingStatus.data?.completedAt == null}
          onStartGuide={startGuide}
          onSkip={skip}
          onSetupInstead={setupInstead}
        />
      ) : null}
      {setupOfferOpen ? (
        <SetupOffer
          onAccept={() => {
            setSetupOfferOpen(false);
            openJourney();
          }}
          onLater={() => {
            setSetupOfferOpen(false);
            setOpen(true);
          }}
        />
      ) : null}
    </WelcomeContext.Provider>
  );
}

/** Vignette-only vs layered-imagery Polaroids, flippable live for review. */
function resolveVariant(): WelcomeVariant {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get(
      "welcomeVariant",
    );
    if (param === "imagery" || param === "vignette") return param;
  }
  return process.env.NEXT_PUBLIC_WELCOME_VARIANT?.trim().toLowerCase() ===
    "imagery"
    ? "imagery"
    : "vignette";
}

function SetupOffer({
  onAccept,
  onLater,
}: {
  onAccept: () => void;
  onLater: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-900/50 p-4">
      <div
        role="dialog"
        aria-label={WELCOME_COPY.allDone.title}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center shadow-xl"
      >
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
          <PartyPopper className="h-5 w-5" aria-hidden="true" />
        </span>
        <h2 className="mt-3 font-heading text-lg font-semibold">
          {WELCOME_COPY.allDone.title}
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          {WELCOME_COPY.allDone.body}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button variant="ghost" size="sm" onClick={onLater}>
            {WELCOME_COPY.allDone.later}
          </Button>
          <Button size="sm" onClick={onAccept}>
            {WELCOME_COPY.allDone.accept}
          </Button>
        </div>
      </div>
    </div>
  );
}
