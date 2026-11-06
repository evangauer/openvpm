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
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Lock,
  RotateCcw,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  BUILD_PRACTICE_PROFILES,
  BUILD_SCENE_LABELS,
  BUILD_SCENES,
  BUILD_SYSTEMS,
  BUILD_PRACTICE_TYPES,
  BUILD_SAVE_DISCLOSURE_TEXT,
  BUILD_SAVE_DISCLOSURE_VERSION,
  type BuildDraft,
  type BuildSavedState,
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
import { ClinicMark } from "./mockups";
import {
  BookStage,
  brandName,
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
/** The logo preview lives apart from the draft: it can be ~100 KB. */
const LOGO_KEY = "openvpm_build_logo";
/** Read by the workspace after checkout to upload the logo for real. */
export const PENDING_LOGO_KEY = "openvpm_build_logo_pending";

const INITIAL_STATE: BuildState = {
  practiceType: "companion",
  currentSystem: "cornerstone",
  clinicName: "",
  brandColor: "#0d9488",
  services: servicesFor("companion"),
  logo: null,
};

/** Scenes that tell the day-at-the-clinic story. */
const STORY_SCENES: ReadonlySet<BuildScene> = new Set([
  "book",
  "remind",
  "visit",
  "paid",
]);

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
    title: () => "A client books while you're off the clock.",
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
    title: (d) =>
      `You focus on ${BUILD_PRACTICE_PROFILES[d.practiceType].sample.pet}. The note writes itself.`,
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
    title: (d) => `${brandName(d)} is ready for you.`,
    lead: () =>
      "That was your day: clients booked, got their reminders, and paid on their own while you did the work only you can do. Everything you built is saved. Start your free trial to open it.",
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
    let logo: string | null = null;
    try {
      const storedLogo = window.localStorage.getItem(LOGO_KEY);
      if (storedLogo?.startsWith("data:image/")) logo = storedLogo;
    } catch {
      // A missing logo preview is fine.
    }
    const scene = Number(saved.scene);
    return {
      state: { ...state, logo },
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

function toSavedState(state: BuildState): BuildSavedState {
  return {
    practiceType: state.practiceType,
    currentSystem: state.currentSystem,
    clinicName: state.clinicName.trim(),
    brandColor: state.brandColor.toLowerCase(),
    services: state.services.map((service) => ({
      name: service.name,
      price: Math.round(service.price * 100) / 100,
      on: service.on,
    })),
  };
}

async function saveProgress(
  email: string,
  scene: BuildScene,
  state: BuildState,
): Promise<boolean> {
  try {
    const response = await fetch("/api/growth/build-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        anonymousId: getFunnelVisitorId() ?? undefined,
        scene,
        state: toSavedState(state),
        disclosureVersion: BUILD_SAVE_DISCLOSURE_VERSION,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
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
  const [direction, setDirection] = useState(1);
  const [savedEmail, setSavedEmail] = useState<string | null>(null);
  const enteredAt = useRef(Date.now());

  const scene = BUILD_SCENES[index]!;

  useEffect(() => {
    const saved = restore();
    if (saved) {
      setDraft(saved.state);
      setIndex(saved.scene);
    }
    try {
      setSavedEmail(window.localStorage.getItem(`${STORAGE_KEY}_email`));
    } catch {
      // Without storage the save card simply shows again.
    }
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches);

    // A resume link from email restores the build saved on the server.
    const token = new URLSearchParams(window.location.search).get("resume");
    if (!token) {
      setRestored(true);
      return;
    }
    void fetch(`/api/growth/build-resume?token=${encodeURIComponent(token)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { state?: BuildSavedState; scene?: BuildScene } | null) => {
        if (body?.state) {
          setDraft((prev) => ({ ...prev, ...body.state, logo: prev.logo }));
          const at = BUILD_SCENES.indexOf(body.scene ?? "practice");
          setIndex(at >= 0 ? at : 0);
        }
      })
      .catch(() => undefined)
      .finally(() => setRestored(true));
  }, []);

  useEffect(() => {
    if (!restored) return;
    const { logo, ...rest } = draft;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: rest, scene: index }),
      );
      if (logo) window.localStorage.setItem(LOGO_KEY, logo);
      else window.localStorage.removeItem(LOGO_KEY);
    } catch {
      // Progress saving is a convenience; private modes may refuse it.
    }
  }, [draft, index, restored]);

  // Once someone saved by email, keep their saved build current as they go,
  // so the resume link and the follow-up note reflect where they stopped.
  useEffect(() => {
    if (!restored || !savedEmail) return;
    void saveProgress(savedEmail, scene, draft);
    // Re-save on scene changes only, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, restored, savedEmail]);

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
    setDirection(next > index ? 1 : -1);
    setIndex(Math.max(0, Math.min(BUILD_SCENES.length - 1, next)));
  };

  const copy = COPY[scene];
  const Stage = STAGES[scene];
  const Controls = CONTROLS[scene];
  const props: SceneProps = { draft, update, playId, still };
  const isGate = scene === "gate";
  const ready = canContinue(scene, draft);
  const eyebrow = STORY_SCENES.has(scene)
    ? `A day at ${brandName(draft)}`
    : isGate
      ? "Your clinic, ready"
      : `Building ${brandName(draft)}`;

  return (
    <main
      id="main-content"
      className="min-h-screen bg-[linear-gradient(135deg,#fff7ed_0%,#f5f3ff_35%,#fdf2f8_65%,#ecfdf5_100%)] px-3 py-4 text-slate-900 sm:px-6 sm:py-8"
      style={{ "--b": draft.brandColor } as CSSProperties}
    >
      <div className="mx-auto w-full max-w-6xl overflow-hidden rounded-3xl bg-white/95 shadow-[0_30px_80px_-30px_rgba(15,23,42,0.35)] ring-1 ring-slate-200/70">
        <header className="flex items-center gap-4 border-b border-slate-100 px-5 py-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <ClinicMark name={displayName(draft)} logo={draft.logo} size={28} />
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

        <AnimatePresence mode="wait" initial={false} custom={direction}>
        <motion.div
          key={scene}
          custom={direction}
          initial={still ? false : { opacity: 0, x: 40 * direction }}
          animate={{ opacity: 1, x: 0 }}
          exit={still ? undefined : { opacity: 0, x: -40 * direction }}
          transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          className="grid gap-6 px-5 py-6 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10"
        >
          <section className="min-w-0">
            <p
              className="mb-2 text-xs font-semibold uppercase tracking-[0.12em]"
              style={{ color: "var(--b)" }}
            >
              {eyebrow}
            </p>
            <h1 className="font-heading text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
              {copy.title(draft)}
            </h1>
            <p className="mt-3 text-base leading-7 text-slate-600">
              {copy.lead(draft)}
            </p>
            {copy.note ? (
              <p className="mt-3 text-sm leading-6 text-slate-500">{copy.note}</p>
            ) : null}
            {scene === "services" ? (
              <SaveProgress
                draft={draft}
                savedEmail={savedEmail}
                onSaved={(email) => {
                  setSavedEmail(email);
                  try {
                    window.localStorage.setItem(`${STORAGE_KEY}_email`, email);
                  } catch {
                    // Saved on the server either way.
                  }
                }}
              />
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
                defaultEmail={savedEmail ?? ""}
                trialDays={trialDays}
                monthlyPriceUsd={monthlyPriceUsd}
                acquisition={acquisition}
              />
            ) : null}
          </section>
          <section className="min-w-0">
            <Stage {...props} />
          </section>
        </motion.div>
        </AnimatePresence>

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

function SaveProgress({
  draft,
  savedEmail,
  onSaved,
}: {
  draft: BuildState;
  savedEmail: string | null;
  onSaved: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  if (savedEmail) {
    return (
      <p className="mt-5 inline-flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1.5 text-sm text-slate-600 ring-1 ring-slate-200">
        <Check className="h-4 w-4" style={{ color: "var(--b)" }} />
        Saved for {savedEmail}
      </p>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setState("error");
      return;
    }
    setState("saving");
    if (await saveProgress(value, "services", draft)) {
      onSaved(value);
      setState("idle");
    } else {
      setState("error");
    }
  };
  return (
    <motion.form
      onSubmit={submit}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-5 rounded-2xl border border-slate-200 bg-slate-50/70 p-3"
    >
      <p className="text-sm font-semibold text-slate-800">
        Save {brandName(draft)} so you don&apos;t lose it
      </p>
      <div className="mt-2 flex gap-2">
        <input
          type="email"
          autoComplete="email"
          placeholder="you@yourclinic.com"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setState("idle");
          }}
          aria-label="Email to save your progress"
          className="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-[var(--b)]"
        />
        <button
          type="submit"
          disabled={state === "saving"}
          className="h-10 rounded-xl px-4 text-sm font-semibold text-white disabled:opacity-60"
          style={{ background: "var(--b)" }}
        >
          {state === "saving" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </button>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        {state === "error"
          ? "That didn't save. Check the address and try again."
          : BUILD_SAVE_DISCLOSURE_TEXT}
      </p>
    </motion.form>
  );
}

function GateForm({
  draft,
  defaultEmail,
  trialDays,
  monthlyPriceUsd,
  acquisition,
}: {
  draft: BuildState;
  defaultEmail: string;
  trialDays: number;
  monthlyPriceUsd: number;
  acquisition: ReturnType<typeof acquisitionFromSearchParams>;
}) {
  const [email, setEmail] = useState(defaultEmail);
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
          // Hand the logo to the workspace, which uploads it after checkout.
          if (draft.logo) {
            window.localStorage.setItem(PENDING_LOGO_KEY, draft.logo);
          }
          window.localStorage.removeItem(STORAGE_KEY);
          window.localStorage.removeItem(LOGO_KEY);
          window.localStorage.removeItem(`${STORAGE_KEY}_email`);
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
