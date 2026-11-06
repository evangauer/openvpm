"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type FormEvent,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Loader2, Lock, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  BUILD_PRACTICE_PROFILES,
  BUILD_SCENE_LABELS,
  BUILD_SCENES,
  BUILD_SYSTEMS,
  BUILD_PRACTICE_TYPES,
  type BuildDraft,
  type BuildScene,
} from "@/lib/build/catalog";
import {
  acquisitionFromSearchParams,
  acquisitionWithFunnelVisitorId,
} from "@/lib/acquisition";
import { FUNNEL_EVENTS } from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";
import { getFunnelVisitorId } from "@/lib/funnel-visitor";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import {
  CLINIC_REGION_OPTIONS,
  type ClinicRegionCode,
} from "@/lib/locale/clinic-regions";
import { ClinicMark, buildStyles as styles } from "./mockups";
import {
  BookStage,
  BrandControls,
  BrandStage,
  displayName,
  GateStage,
  PaidStage,
  PracticeControls,
  PracticeStage,
  RecordsStage,
  RemindStage,
  servicesFor,
  ServicesControls,
  ServicesStage,
  VisitStage,
  type BuildState,
  type SceneProps,
} from "./scenes";

const STORAGE_KEY = "openvpm_build_v1";

const INITIAL_STATE: BuildState = {
  practiceType: "companion",
  currentSystem: "cornerstone",
  clinicName: "",
  brandColor: "#0d9488",
  services: servicesFor("companion"),
};

interface SceneCopy {
  title: (draft: BuildState) => string;
  lead: (draft: BuildState) => string;
  note?: string;
  replay?: boolean;
}

const COPY: Record<BuildScene, SceneCopy> = {
  practice: {
    title: (d) => `Let's build ${displayName(d)} on OpenVPM.`,
    lead: () =>
      "About three minutes. Tell us how you practice and we'll shape the whole system around it.",
  },
  brand: {
    title: () => "Make it unmistakably yours.",
    lead: () =>
      "Your name and colour carry through everything clients see: booking, reminders, the portal, and invoices.",
  },
  services: {
    title: () => "Your services, your prices.",
    lead: () =>
      "We started you with what practices like yours usually offer. Keep, drop, or reprice them.",
  },
  book: {
    title: () => "Watch a client book with you.",
    lead: (d) => {
      const { owner, pet } = BUILD_PRACTICE_PROFILES[d.practiceType].sample;
      return `${owner} books ${pet}'s visit from their phone. It lands on ${displayName(d)}'s schedule, and ${pet}'s chart is created from the booking before the visit.`;
    },
    replay: true,
  },
  remind: {
    title: () => "Reminders go out on their own.",
    lead: (d) =>
      `The day before, ${BUILD_PRACTICE_PROFILES[d.practiceType].sample.owner} gets a reminder in your name. Recalls and care reminders go out the same way, in bulk.`,
    note: "Texting turns on after a short carrier registration, and we walk you through it. Email works from day one.",
    replay: true,
  },
  visit: {
    title: () => "The visit, without the paperwork.",
    lead: (d) =>
      `${BUILD_PRACTICE_PROFILES[d.practiceType].sample.pet} checks in and the whole team sees it. The AI drafts the SOAP note for you to review, and charges flow straight onto the invoice.`,
    replay: true,
  },
  paid: {
    title: () => "Paid on the spot.",
    lead: (d) =>
      `The invoice lands in ${BUILD_PRACTICE_PROFILES[d.practiceType].sample.owner}'s portal and they pay by card in a tap. It's recorded on your side automatically.`,
    note: "Card payments use your own Stripe account, connected in a few minutes.",
    replay: true,
  },
  records: {
    title: () => "Bring your history with you.",
    lead: (d) =>
      d.currentSystem === "paper" || d.currentSystem === "other"
        ? "Import a spreadsheet of clients and pets, or start fresh with today's appointments. Need a hand? We'll help you move it."
        : "Upload your export and review every record before it's saved. Your current system stays in place until you're ready. Need a hand? We'll help you move it.",
    replay: true,
  },
  gate: {
    title: (d) => `${displayName(d)} is ready.`,
    lead: () =>
      "Everything you just built is saved. Start your free trial to open your workspace.",
  },
};

const STAGES: Record<BuildScene, ComponentType<SceneProps>> = {
  practice: PracticeStage,
  brand: BrandStage,
  services: ServicesStage,
  book: BookStage,
  remind: RemindStage,
  visit: VisitStage,
  paid: PaidStage,
  records: RecordsStage,
  gate: GateStage,
};

const CONTROLS: Partial<Record<BuildScene, ComponentType<SceneProps>>> = {
  practice: PracticeControls,
  brand: BrandControls,
  services: ServicesControls,
};

function restore(): { state: BuildState; scene: number } | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { state?: BuildState; scene?: number };
    const state = saved.state;
    if (
      !state ||
      !BUILD_PRACTICE_TYPES.includes(state.practiceType) ||
      !BUILD_SYSTEMS.includes(state.currentSystem) ||
      typeof state.clinicName !== "string" ||
      !/^#[0-9a-fA-F]{6}$/.test(state.brandColor) ||
      !Array.isArray(state.services)
    ) {
      return null;
    }
    const scene = Number(saved.scene);
    return {
      state,
      scene:
        Number.isInteger(scene) && scene >= 0 && scene < BUILD_SCENES.length
          ? scene
          : 0,
    };
  } catch {
    return null;
  }
}

function canContinue(scene: BuildScene, draft: BuildState): boolean {
  if (scene === "brand") return draft.clinicName.trim().length >= 2;
  if (scene === "services") return draft.services.some((s) => s.on);
  return true;
}

export function toBuildDraft(state: BuildState): BuildDraft {
  return {
    practiceType: state.practiceType,
    currentSystem: state.currentSystem,
    brandColor: state.brandColor.toLowerCase(),
    services: state.services
      .filter((service) => service.on)
      .map((service) => ({
        name: service.name,
        price: Math.round(service.price * 100) / 100,
      })),
  };
}

/**
 * "Build your clinic": a guided walk through OpenVPM with the clinic's own
 * name, colour, and services, ending at the card gate. Nothing is created
 * until the gate; choices live in this browser until then.
 */
export function BuildFlow({
  trialDays,
  monthlyPriceUsd,
}: {
  trialDays: number;
  monthlyPriceUsd: number;
}) {
  const searchParams = useSearchParams();
  const acquisition = useMemo(
    () => acquisitionFromSearchParams(searchParams),
    // Attribution is a snapshot of the landing URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [draft, setDraft] = useState<BuildState>(INITIAL_STATE);
  const [index, setIndex] = useState(0);
  const [restored, setRestored] = useState(false);
  const [playId, setPlayId] = useState(0);
  const [still, setStill] = useState(false);
  const enteredAt = useRef(Date.now());

  const scene = BUILD_SCENES[index]!;

  useEffect(() => {
    const saved = restore();
    if (saved) {
      setDraft(saved.state);
      setIndex(saved.scene);
    }
    setRestored(true);
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: draft, scene: index }),
      );
    } catch {
      // Progress saving is a convenience; private modes may refuse it.
    }
  }, [draft, index, restored]);

  useEffect(() => {
    if (!restored) return;
    enteredAt.current = Date.now();
    setPlayId((id) => id + 1);
    trackFunnelEvent(FUNNEL_EVENTS.buildSceneViewed, {
      scene,
      model: draft.practiceType,
      system: draft.currentSystem,
    });
    window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
    // Tracks entering a scene; later edits within it are not new views.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, restored]);

  const update = useCallback(
    (patch: Partial<BuildState>) => setDraft((prev) => ({ ...prev, ...patch })),
    [],
  );

  const go = (next: number) => {
    if (next > index) {
      trackFunnelEvent(FUNNEL_EVENTS.buildSceneCompleted, {
        scene,
        model: draft.practiceType,
        system: draft.currentSystem,
        services: draft.services.filter((s) => s.on).length,
        ms: Math.min(Date.now() - enteredAt.current, 60 * 60 * 1000),
      });
    }
    setIndex(Math.max(0, Math.min(BUILD_SCENES.length - 1, next)));
  };

  const copy = COPY[scene];
  const Stage = STAGES[scene];
  const Controls = CONTROLS[scene];
  const props: SceneProps = { draft, update, playId, still };
  const isGate = scene === "gate";
  const ready = canContinue(scene, draft);

  return (
    <main
      id="main-content"
      className="min-h-screen bg-[linear-gradient(135deg,#fff7ed_0%,#f5f3ff_35%,#fdf2f8_65%,#ecfdf5_100%)] px-3 py-4 text-slate-900 sm:px-6 sm:py-8"
      style={{ "--b": draft.brandColor } as CSSProperties}
    >
      <div className="mx-auto w-full max-w-6xl overflow-hidden rounded-3xl bg-white/95 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.35)] ring-1 ring-slate-200/70">
        <header className="flex items-center gap-4 border-b border-slate-100 px-5 py-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <ClinicMark name={displayName(draft)} />
            <span className="truncate font-heading text-base font-semibold">
              {draft.clinicName.trim() || "Your clinic"}
            </span>
          </div>
          <div
            className="ml-auto hidden flex-1 gap-1 sm:flex"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={BUILD_SCENES.length}
            aria-valuenow={index + 1}
            aria-label="Build progress"
          >
            {BUILD_SCENES.map((id, i) => (
              <span
                key={id}
                className="h-1.5 flex-1 rounded-full transition-colors duration-500"
                style={{ background: i <= index ? "var(--b)" : "#e2e8f0" }}
              />
            ))}
          </div>
          <span className="whitespace-nowrap text-xs text-slate-500">
            {index + 1} of {BUILD_SCENES.length} · {BUILD_SCENE_LABELS[scene]}
          </span>
        </header>

        <div
          key={scene}
          className={cn(
            styles.sceneIn,
            "grid gap-6 px-5 py-6 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10",
          )}
        >
          <section className="min-w-0">
            <h1 className="font-heading text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              {copy.title(draft)}
            </h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              {copy.lead(draft)}
            </p>
            {copy.note ? (
              <p className="mt-3 text-sm leading-6 text-slate-500">{copy.note}</p>
            ) : null}
            {Controls ? (
              <div className="mt-6">
                <Controls {...props} />
              </div>
            ) : null}
            {copy.replay && !still ? (
              <button
                type="button"
                onClick={() => setPlayId((id) => id + 1)}
                className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Play it again
              </button>
            ) : null}
            {isGate ? (
              <GateForm
                draft={draft}
                trialDays={trialDays}
                monthlyPriceUsd={monthlyPriceUsd}
                acquisition={acquisition}
              />
            ) : null}
          </section>
          <section className="min-w-0">
            <Stage {...props} />
          </section>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 sm:px-8">
          {index > 0 ? (
            <button
              type="button"
              onClick={() => go(index - 1)}
              className="inline-flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          ) : (
            <Link
              href="/login"
              className="text-sm text-slate-500 hover:text-slate-800"
            >
              Already have an account? Sign in
            </Link>
          )}
          {!isGate ? (
            <button
              type="button"
              disabled={!ready}
              onClick={() => go(index + 1)}
              className="inline-flex h-11 items-center gap-2 rounded-xl px-5 text-sm font-semibold text-white shadow-lg transition-[background,opacity] duration-500 disabled:opacity-50"
              style={{ background: "var(--b)" }}
            >
              {scene === "records" ? "See my clinic" : "Continue"}
              <ArrowRight className="h-4 w-4" />
            </button>
          ) : null}
        </footer>
      </div>
    </main>
  );
}

function GateForm({
  draft,
  trialDays,
  monthlyPriceUsd,
  acquisition,
}: {
  draft: BuildState;
  trialDays: number;
  monthlyPriceUsd: number;
  acquisition: ReturnType<typeof acquisitionFromSearchParams>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [country, setCountry] = useState<ClinicRegionCode | "">("");
  const [error, setError] = useState("");

  const register = trpc.auth.register.useMutation({
    onSuccess: (data) => {
      trackFunnelEvent(FUNNEL_EVENTS.signupSucceeded, {
        model: draft.practiceType,
        step: "account",
      });
      if (data.checkoutUrl && isSafeCheckoutRedirectUrl(data.checkoutUrl)) {
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch {
          // The account exists either way.
        }
        window.location.href = data.checkoutUrl;
        return;
      }
      setError("Secure checkout is unavailable right now. Please try again.");
    },
    onError: (err) => setError(err.message),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!country) {
      setError("Choose your clinic's country.");
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    setError("");
    const build = toBuildDraft(draft);
    trackFunnelEvent(FUNNEL_EVENTS.buildGateSubmitted, {
      model: draft.practiceType,
      system: draft.currentSystem,
      services: build.services.length,
    });
    trackFunnelEvent(FUNNEL_EVENTS.signupSubmitted, {
      model: draft.practiceType,
      step: "account",
    });
    register.mutate({
      email: email.trim().toLowerCase(),
      password,
      practiceName: draft.clinicName.trim(),
      country,
      acquisition: acquisitionWithFunnelVisitorId(
        acquisition,
        getFunnelVisitorId(),
      ),
      build,
    });
  };

  const field =
    "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-[var(--b)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--b)_25%,white)]";

  return (
    <form onSubmit={submit} className="mt-6 space-y-3" noValidate>
      <div className="flex items-baseline gap-2">
        <span className="font-heading text-2xl font-bold">${monthlyPriceUsd}</span>
        <span className="text-sm text-slate-500">
          /month per location · free for {trialDays} days
        </span>
      </div>
      {error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <input
        type="email"
        required
        autoComplete="email"
        placeholder="Work email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className={field}
        aria-label="Work email"
      />
      <input
        type="password"
        required
        autoComplete="new-password"
        placeholder="Create a password (8+ characters)"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className={field}
        aria-label="Password"
      />
      <select
        required
        value={country}
        onChange={(event) => setCountry(event.target.value as ClinicRegionCode)}
        className={field}
        aria-label="Clinic country"
      >
        <option value="">Clinic country</option>
        {CLINIC_REGION_OPTIONS.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={register.isPending}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold text-white shadow-lg transition-[background] duration-500 disabled:opacity-60"
        style={{ background: "var(--b)" }}
      >
        {register.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Opening secure checkout
          </>
        ) : (
          <>
            Add card &amp; open my clinic
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
      <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
        <Lock className="h-3.5 w-3.5" />
        Secure checkout by Stripe · no charge today
      </p>
      <p className="text-center text-xs leading-5 text-slate-500">
        After your {trialDays}-day trial, ${monthlyPriceUsd} USD/month per
        active location, plus applicable taxes and usage overages. Billing
        starts automatically. Cancel in Settings → Plan &amp; Billing before
        the trial ends to avoid a subscription charge. By continuing you agree
        to the{" "}
        <Link href="/legal/terms" className="underline">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/legal/privacy" className="underline">
          Privacy Policy
        </Link>
        .
      </p>
    </form>
  );
}
