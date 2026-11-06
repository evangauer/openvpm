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
  type RefObject,
} from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Lock,
  RotateCcw,
} from "lucide-react";
import {
  BellRing,
  CalendarCheck,
  Clock,
  CreditCard,
  Eye,
  Heart,
  LifeBuoy,
  MessageSquare,
  PawPrint,
  PhoneOff,
  Receipt,
  Smartphone,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { BillingCadence } from "@/lib/billing/catalog";
import { trpc } from "@/lib/trpc";
import {
  BUILD_PRACTICE_PROFILES,
  BUILD_SCENE_LABELS,
  BUILD_SCENES,
  BUILD_SYSTEM_LABELS,
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
  GateSummary,
  PaidStage,
  PracticeControls,
  PracticeStage,
  RecordsPromise,
  RecordsStage,
  ScenePoints,
  type ScenePoint,
  RemindStage,
  servicesFor,
  ServicesControls,
  ServicesStage,
  VisitStage,
  type BuildState,
  type SceneProps,
} from "./scenes";

/**
 * The welcome screen's soft pastel gradient, with a touch of the OpenVPM
 * teal glowing in from the corners.
 */
const PAGE_BACKGROUND = [
  "radial-gradient(60% 55% at 100% 100%, hsl(166 91% 32% / 0.16), transparent 70%)",
  "radial-gradient(45% 40% at 0% 0%, hsl(166 91% 32% / 0.07), transparent 70%)",
  "linear-gradient(135deg, #fff7ed 0%, #f5f3ff 30%, #fdf2f8 60%, #ecfdf5 100%)",
].join(", ");

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

interface SceneCopy {
  title: (draft: BuildState) => string;
  lead: (draft: BuildState) => string;
  /** Why this matters to the clinic, its team, and its clients. */
  points?: (draft: BuildState) => ScenePoint[];
  note?: string;
  replay?: boolean;
}

const sample = (d: BuildState) => BUILD_PRACTICE_PROFILES[d.practiceType].sample;

const COPY: Record<BuildScene, SceneCopy> = {
  practice: {
    title: (d) => `Let's build ${displayName(d)} on OpenVPM.`,
    lead: () =>
      "About three minutes. Tell us how you practice and we'll shape everything around it.",
  },
  brand: {
    title: () => "Make it unmistakably yours.",
    lead: () =>
      "Your name and color show up everywhere your clients do: booking, reminders, the portal, and invoices.",
  },
  services: {
    title: () => "Your services, your prices.",
    lead: () =>
      "Start with what practices like yours usually offer, then add your own. Clients see these when they book.",
  },
  book: {
    title: () => "A client books while you're off the clock.",
    lead: (d) =>
      `${sample(d).owner} books ${sample(d).pet}'s visit from their phone at 9:41 PM. It's on your schedule before you wake up.`,
    points: (d) => [
      { icon: Heart, text: "Clients book whenever it suits them, from a page in your brand." },
      { icon: PhoneOff, text: "Your front desk spends less time on the phone." },
      { icon: PawPrint, text: `${sample(d).pet}'s chart is started before the visit.` },
    ],
    replay: true,
  },
  remind: {
    title: () => "Reminders go out on their own.",
    lead: (d) =>
      `The day before, ${sample(d).owner} gets a friendly reminder in your name, and their reply lands in your inbox.`,
    points: () => [
      { icon: CalendarCheck, text: "Fewer no-shows, without anyone making calls." },
      { icon: MessageSquare, text: "Replies land in one inbox the whole team can see." },
      { icon: BellRing, text: "Recalls for every pet that's due go out in one click." },
    ],
    note: "Email works from day one. Texting turns on after a quick carrier registration we walk you through.",
    replay: true,
  },
  visit: {
    title: (d) => `You focus on ${sample(d).pet}. The note writes itself.`,
    lead: () =>
      "The AI drafts the SOAP note from the exam for you to review, and charges flow straight onto the invoice.",
    points: () => [
      { icon: Clock, text: "Notes are done before the next patient, not after closing." },
      { icon: Receipt, text: "Charges land on the invoice as you work, so nothing slips." },
      { icon: Heart, text: "Your attention stays on the patient and the family." },
    ],
    replay: true,
  },
  paid: {
    title: () => "Paid on the spot.",
    lead: (d) =>
      `The invoice lands in ${sample(d).owner}'s portal and they pay by card in a tap. It's recorded on your side automatically.`,
    points: () => [
      { icon: CreditCard, text: "Get paid before clients reach the car." },
      { icon: Receipt, text: "No statements to mail and no balances to chase." },
      { icon: Smartphone, text: "Clients pay from their phone, wherever they are." },
    ],
    note: "Payments go to your own Stripe account, connected in a few minutes.",
    replay: true,
  },
  records: {
    title: () => "Bring your history with you.",
    lead: (d) =>
      d.currentSystem === "paper" || d.currentSystem === "other"
        ? "Import a spreadsheet of clients and pets, or start fresh."
        : `Upload your ${BUILD_SYSTEM_LABELS[d.currentSystem]} export and every client, pet, and vaccine comes with you.`,
    points: () => [
      { icon: Eye, text: "Review every record before anything is saved." },
      { icon: LifeBuoy, text: "Need a hand? We'll help you move it." },
    ],
    replay: true,
  },
  gate: {
    title: (d) => `${brandName(d)} is ready for you.`,
    lead: () =>
      "Everything you built is saved. Start your free trial and open it today.",
  },
};

/** The picture on the right; the gate shows the payment card instead. */
const STAGES: Partial<Record<BuildScene, ComponentType<SceneProps>>> = {
  practice: PracticeStage,
  brand: BrandStage,
  services: ServicesStage,
  book: BookStage,
  remind: RemindStage,
  visit: VisitStage,
  paid: PaidStage,
  records: RecordsStage,
};

/** The one thing to do on the left, under the copy. */
const CONTROLS: Partial<Record<BuildScene, ComponentType<SceneProps>>> = {
  practice: PracticeControls,
  brand: BrandControls,
  services: ServicesControls,
  records: RecordsPromise,
  gate: GateSummary,
};

function restore(): {
  state: BuildState;
  scene: number;
  cadence: BillingCadence;
} | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as {
      state?: BuildState;
      scene?: number;
      cadence?: BillingCadence;
    };
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
      cadence: saved.cadence === "year" ? "year" : "month",
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
 * name, color, and services, ending at the card gate. Nothing is created
 * until the gate; choices live in this browser until then.
 */
export function BuildFlow({
  trialDays,
  monthlyPriceUsd,
  annualPriceUsd,
}: {
  trialDays: number;
  monthlyPriceUsd: number;
  /** Null when annual billing isn't offered. */
  annualPriceUsd: number | null;
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
  const [cadence, setCadence] = useState<BillingCadence>("month");
  const [resumeError, setResumeError] = useState<string | null>(null);
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
      setCadence(saved.cadence);
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
      .then((response) => {
        if (!response.ok) {
          setResumeError(
            response.status === 404
              ? "This saved-progress link has expired or is no longer available. You can continue with this browser’s progress, or start building your clinic below."
              : "We couldn’t load your saved progress. Try opening the link again, or continue below.",
          );
          return null;
        }
        return response.json();
      })
      .then((body: { state?: BuildSavedState; scene?: BuildScene } | null) => {
        if (body?.state) {
          setDraft((prev) => ({ ...prev, ...body.state, logo: prev.logo }));
          const at = BUILD_SCENES.indexOf(body.scene ?? "practice");
          setIndex(at >= 0 ? at : 0);
        }
      })
      .catch(() => setResumeError(
        "We couldn’t load your saved progress. Try opening the link again.",
      ))
      .finally(() => setRestored(true));
  }, []);

  useEffect(() => {
    if (!restored) return;
    const { logo, ...rest } = draft;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ state: rest, scene: index, cadence }),
      );
      if (logo) window.localStorage.setItem(LOGO_KEY, logo);
      else window.localStorage.removeItem(LOGO_KEY);
    } catch {
      // Progress saving is a convenience; private modes may refuse it.
    }
  }, [draft, index, cadence, restored]);

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

  const rememberEmail = useCallback((email: string) => {
    setSavedEmail(email);
    try {
      window.localStorage.setItem(`${STORAGE_KEY}_email`, email);
    } catch {
      // Saved on the server either way.
    }
  }, []);

  // Leaving the save step without saving: keep a typed address, otherwise
  // check once that they meant to skip it.
  const saveInput = useRef<HTMLInputElement>(null);
  const [askedToSave, setAskedToSave] = useState(false);
  const [confirmingSkip, setConfirmingSkip] = useState(false);

  const go = (next: number, skipSaveCheck = false) => {
    if (scene === "book" && next > index && !savedEmail && !skipSaveCheck) {
      const typed = saveInput.current?.value.trim().toLowerCase() ?? "";
      if (EMAIL_PATTERN.test(typed)) {
        void saveProgress(typed, scene, draft).then((ok) => {
          if (ok) rememberEmail(typed);
        });
      } else if (!askedToSave) {
        setAskedToSave(true);
        setConfirmingSkip(true);
        saveInput.current?.focus();
        return;
      }
    }
    setConfirmingSkip(false);
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

  return (
    <MotionConfig reducedMotion="user">
    <main
      id="main-content"
      className="flex min-h-screen flex-col justify-center px-3 py-4 text-slate-900 sm:px-6 sm:py-8"
      style={
        {
          "--b": draft.brandColor,
          background: PAGE_BACKGROUND,
        } as CSSProperties
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <header className="flex h-16 items-center gap-6 border-b border-slate-100 px-5 sm:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <ClinicMark name={displayName(draft)} logo={draft.logo} size={28} />
            <span className="truncate font-heading text-[15px] font-semibold">
              {brandName(draft)}
            </span>
          </div>
          <div
            className="ml-auto hidden max-w-md flex-1 gap-1 sm:flex"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={BUILD_SCENES.length}
            aria-valuenow={index + 1}
            aria-label="Build progress"
          >
            {BUILD_SCENES.map((id, i) => (
              <span
                key={id}
                className="h-1 flex-1 rounded-full transition-colors duration-500"
                style={{ background: i <= index ? "var(--b)" : "#e2e8f0" }}
              />
            ))}
          </div>
          <span className="ml-auto whitespace-nowrap text-xs text-slate-500 sm:ml-0">
            {index + 1} of {BUILD_SCENES.length} · {BUILD_SCENE_LABELS[scene]}
          </span>
        </header>

        {resumeError ? (
          <p role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900 sm:px-8">
            {resumeError}
          </p>
        ) : null}
        <AnimatePresence mode="wait" initial={false} custom={direction}>
          <motion.div
            key={scene}
            custom={direction}
            initial={still ? false : { opacity: 0, x: 24 * direction }}
            animate={{ opacity: 1, x: 0 }}
            exit={still ? undefined : { opacity: 0, x: -24 * direction }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="grid gap-8 px-5 py-6 sm:px-8 sm:py-8 lg:min-h-[630px] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12"
          >
            <section className="min-w-0 lg:pt-1">
              <h1 className="font-heading text-[28px] font-semibold leading-[1.15] tracking-tight sm:text-[32px]">
                {copy.title(draft)}
              </h1>
              <p className="mt-3 text-[15px] leading-7 text-slate-600">
                {copy.lead(draft)}
              </p>
              {copy.points ? (
                <div className="mt-6">
                  <ScenePoints points={copy.points(draft)} />
                </div>
              ) : null}
              {copy.note ? (
                <p className="mt-5 text-sm leading-6 text-slate-500">{copy.note}</p>
              ) : null}
              {Controls ? (
                <div className="mt-7">
                  <Controls {...props} />
                </div>
              ) : null}
              {scene === "book" ? (
                <SaveProgress
                  draft={draft}
                  savedEmail={savedEmail}
                  onSaved={rememberEmail}
                  inputRef={saveInput}
                  confirmingSkip={confirmingSkip}
                  onSkip={() => go(index + 1, true)}
                  autoFocus={!still}
                />
              ) : null}
              {copy.replay && !still ? (
                <button
                  type="button"
                  onClick={() => setPlayId((id) => id + 1)}
                  className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Play it again
                </button>
              ) : null}
            </section>
            <section className="min-w-0">
              {isGate ? (
                <GateForm
                  draft={draft}
                  defaultEmail={savedEmail ?? ""}
                  trialDays={trialDays}
                  monthlyPriceUsd={monthlyPriceUsd}
                  annualPriceUsd={annualPriceUsd}
                  acquisition={acquisition}
                  cadence={cadence}
                  setCadence={setCadence}
                />
              ) : Stage ? (
                <Stage {...props} />
              ) : null}
            </section>
          </motion.div>
        </AnimatePresence>

        <footer className="flex h-[72px] items-center justify-between gap-3 border-t border-slate-100 px-5 sm:px-8">
          {index > 0 ? (
            <button
              type="button"
              onClick={() => go(index - 1)}
              className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
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
              className="inline-flex h-10 items-center gap-2 rounded-lg px-5 text-sm font-semibold text-white transition-[background,opacity] duration-500 disabled:opacity-40"
              style={{ background: "var(--b)" }}
            >
              {scene === "records" ? "See my clinic" : "Continue"}
              <ArrowRight className="h-4 w-4" />
            </button>
          ) : null}
        </footer>
      </div>
    </main>
    </MotionConfig>
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function SaveProgress({
  draft,
  savedEmail,
  onSaved,
  inputRef,
  confirmingSkip,
  onSkip,
  autoFocus,
}: {
  draft: BuildState;
  savedEmail: string | null;
  onSaved: (email: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  confirmingSkip: boolean;
  onSkip: () => void;
  autoFocus: boolean;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  // Ready to type on arrival, on devices with a keyboard; on phones the
  // keyboard would cover the story.
  useEffect(() => {
    if (!autoFocus || savedEmail) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const timer = setTimeout(
      () => inputRef.current?.focus({ preventScroll: true }),
      350,
    );
    return () => clearTimeout(timer);
  }, [autoFocus, savedEmail, inputRef]);

  if (savedEmail) {
    return (
      <p className="mt-7 flex items-center gap-2 text-sm text-slate-600">
        <Check className="h-4 w-4" style={{ color: "var(--b)" }} />
        {brandName(draft)}&apos;s progress is saved for {savedEmail}.
      </p>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(value)) {
      setState("error");
      return;
    }
    setState("saving");
    if (await saveProgress(value, "book", draft)) {
      onSaved(value);
      setState("idle");
    } else {
      setState("error");
    }
  };
  return (
    <form
      onSubmit={submit}
      className={cn(
        "mt-7 rounded-xl border p-4 transition-colors",
        confirmingSkip ? "border-[var(--b)]" : "border-slate-200",
      )}
    >
      <label htmlFor="build-save-email" className="text-sm font-medium text-slate-800">
        Save {brandName(draft)}&apos;s progress
      </label>
      <div className="mt-3 flex gap-2">
        <input
          ref={inputRef}
          id="build-save-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@yourclinic.com"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setState("idle");
          }}
          className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-[var(--b)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--b)_20%,white)]"
        />
        <button
          type="submit"
          disabled={state === "saving"}
          className="inline-flex h-10 min-w-[72px] items-center justify-center rounded-lg px-4 text-sm font-semibold text-white transition-[background,opacity] duration-500 disabled:opacity-60"
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
      {confirmingSkip ? (
        <p className="mt-3 border-t border-slate-100 pt-3 text-sm leading-6 text-slate-700" role="status">
          Continue without saving? {brandName(draft)} will only live in this
          browser.{" "}
          <button
            type="button"
            onClick={onSkip}
            className="font-medium text-slate-500 underline underline-offset-4 hover:text-slate-800"
          >
            Continue anyway
          </button>
        </p>
      ) : null}
    </form>
  );
}

function PlanOption({
  selected,
  onSelect,
  name,
  price,
  interval,
  detail,
  badge,
}: {
  selected: boolean;
  onSelect: () => void;
  name: string;
  price: number;
  interval: string;
  detail: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "relative rounded-xl border p-3.5 text-left transition-colors",
        selected
          ? "border-[var(--b)] bg-[color-mix(in_srgb,var(--b)_5%,white)] ring-1 ring-[var(--b)]"
          : "border-slate-200 hover:border-slate-300",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-900">{name}</span>
        {badge ? (
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{
              background: "color-mix(in srgb, var(--b) 12%, white)",
              color: "color-mix(in srgb, var(--b) 80%, black)",
            }}
          >
            {badge}
          </span>
        ) : null}
      </span>
      <span className="mt-2 block">
        <span className="font-heading text-2xl font-semibold tabular-nums">
          ${price.toLocaleString("en-US")}
        </span>
        <span className="text-sm text-slate-500">{interval}</span>
      </span>
      <span className="mt-0.5 block text-xs text-slate-500">{detail}</span>
    </button>
  );
}

function GateForm({
  draft,
  defaultEmail,
  trialDays,
  monthlyPriceUsd,
  annualPriceUsd,
  acquisition,
  cadence,
  setCadence,
}: {
  draft: BuildState;
  defaultEmail: string;
  trialDays: number;
  monthlyPriceUsd: number;
  annualPriceUsd: number | null;
  acquisition: ReturnType<typeof acquisitionFromSearchParams>;
  cadence: BillingCadence;
  setCadence: (value: BillingCadence) => void;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState("");
  const [country, setCountry] = useState<ClinicRegionCode | "">("");
  const [error, setError] = useState("");
  const annual = annualPriceUsd !== null && cadence === "year";
  const trialEnds = useMemo(
    () =>
      new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toLocaleDateString(
        "en-US",
        { month: "long", day: "numeric" },
      ),
    [trialDays],
  );
  const then = annual
    ? `$${annualPriceUsd.toLocaleString("en-US")}/year`
    : `$${monthlyPriceUsd}/month`;

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
    if (!EMAIL_PATTERN.test(email.trim())) {
      setError("Enter your work email.");
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    if (!country) {
      setError("Choose your clinic's country.");
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
      billingCadence: annual ? "year" : "month",
    });
  };

  const field =
    "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-[var(--b)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--b)_20%,white)]";

  return (
    <form
      onSubmit={submit}
      noValidate
      className="rounded-2xl border border-slate-200 p-5 sm:p-6"
    >
      {annualPriceUsd !== null ? (
        <div role="radiogroup" aria-label="Plan" className="grid grid-cols-2 gap-2.5">
          <PlanOption
            selected={!annual}
            onSelect={() => setCadence("month")}
            name="Monthly"
            price={monthlyPriceUsd}
            interval="/mo"
            detail="Cancel anytime"
          />
          <PlanOption
            selected={annual}
            onSelect={() => setCadence("year")}
            name="Annual"
            price={annualPriceUsd}
            interval="/yr"
            detail={`About $${Math.round(annualPriceUsd / 12)}/mo, billed yearly`}
            badge={`Save $${(monthlyPriceUsd * 12 - annualPriceUsd).toLocaleString("en-US")}`}
          />
        </div>
      ) : (
        <div className="flex items-baseline gap-1">
          <span className="font-heading text-2xl font-semibold">${monthlyPriceUsd}</span>
          <span className="text-sm text-slate-500">/month per location</span>
        </div>
      )}

      <div className="mt-4 rounded-lg bg-slate-50 px-3.5 py-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium text-slate-800">{trialDays}-day free trial</span>
          <span className="font-semibold tabular-nums">$0.00 today</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          Then {then} per location from {trialEnds}. Cancel before then and
          you won&apos;t be charged.
        </p>
      </div>

      <div className="mt-5 space-y-2.5">
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
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
          className={cn(field, !country && "text-slate-400")}
          aria-label="Clinic country"
        >
          <option value="">Clinic country</option>
          {CLINIC_REGION_OPTIONS.map((option) => (
            <option key={option.code} value={option.code} className="text-slate-900">
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={register.isPending}
        className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-white transition-[background,opacity] duration-500 disabled:opacity-60"
        style={{ background: "var(--b)" }}
      >
        {register.isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Opening secure checkout
          </>
        ) : (
          <>
            Start free trial
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>
      <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-500">
        <Lock className="h-3.5 w-3.5" />
        Card details are collected securely by Stripe.
      </p>
      <p className="mt-3 text-center text-[11px] leading-[17px] text-slate-400">
        After your {trialDays}-day trial, {then.replace("/", " USD/")} per
        active location, plus applicable taxes
        {annual ? "" : " and usage overages"}. Billing starts automatically.
        Cancel in Settings → Plan &amp; Billing before the trial ends to avoid a
        subscription charge. By continuing you agree to the{" "}
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
