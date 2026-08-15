"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  Bot,
  Calendar,
  CheckCircle2,
  FileText,
  LayoutDashboard,
  Loader2,
  Package,
  PawPrint,
  Receipt,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { PawMark } from "@/components/brand/paw-mark";
import { cn, initials, isValidEmail } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "@/lib/auth-password-policy";
import {
  AUTH_EMAIL_MAX_LENGTH,
  AUTH_PRACTICE_NAME_MAX_LENGTH,
  isAuthEmailLengthValid,
  isRequiredAuthTextValid,
} from "@/lib/auth-input-policy";
import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";
import {
  acquisitionFromSearchParams,
  acquisitionWithFunnelVisitorId,
} from "@/lib/acquisition";
import { FUNNEL_EVENTS } from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";
import { getFunnelVisitorId } from "@/lib/funnel-visitor";
import {
  CLINIC_REGION_OPTIONS,
  type ClinicRegionCode,
} from "@/lib/locale/clinic-regions";
import { safeAuthNextPath } from "@/lib/auth-redirect";
import { ClinicIntentBuilder } from "@/components/onboarding/clinic-intent-builder";
import { FirstDayRecommendations } from "@/components/onboarding/first-day-recommendations";
import {
  CLINIC_MODELS,
  DEFAULT_CLINIC_MODEL,
  DEFAULT_FIRST_GOAL,
  FIRST_GOALS,
  clinicModelOption,
  type ClinicModel,
  type FirstGoal,
} from "@/lib/onboarding/clinic-profile";

type RegistrationCountry = ClinicRegionCode | "OTHER" | "";
type RegistrationStage = "profile" | "workflow" | "preview" | "account";

const REGISTRATION_PROFILE_STORAGE_KEY = "openvpm:registration-profile:v1";

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const onboardingStageMainClass =
  "min-h-screen bg-[radial-gradient(circle_at_top_left,#fff7ed_0%,transparent_34%),radial-gradient(circle_at_top_right,#ede9fe_0%,transparent_36%),linear-gradient(180deg,#ffffff_0%,#f5fbf8_100%)] px-4 py-4 sm:px-6 sm:py-6";
const onboardingStageFrameClass =
  "mx-auto flex max-w-6xl flex-col overflow-hidden rounded-[28px] border border-white/80 bg-white/95 shadow-[0_30px_90px_-54px_rgba(15,23,42,0.48)] backdrop-blur sm:min-h-[650px] lg:h-[calc(100dvh-5rem)] lg:min-h-[680px] lg:max-h-[730px]";
const onboardingStageHeaderClass =
  "flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4 sm:px-9";
const onboardingStageFooterClass =
  "relative flex shrink-0 flex-col-reverse gap-3 border-t border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-9";

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-white">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <RegisterPageInner />
    </Suspense>
  );
}

function RegisterPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cloudIntent = searchParams.get("intent") === "cloud";
  const nextPath = safeAuthNextPath(searchParams.get("next"), "/");
  const acquisition = acquisitionFromSearchParams(searchParams);
  const [stage, setStage] = useState<RegistrationStage>("profile");
  const [profileRestored, setProfileRestored] = useState(false);
  const [clinicModel, setClinicModel] =
    useState<ClinicModel>(DEFAULT_CLINIC_MODEL);
  const [firstGoal, setFirstGoal] = useState<FirstGoal>(DEFAULT_FIRST_GOAL);
  const [practiceName, setPracticeName] = useState("");
  const [country, setCountry] = useState<RegistrationCountry>("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    trackFunnelEvent(FUNNEL_EVENTS.signupLand, {
      intent: cloudIntent ? "cloud" : "default",
      source: acquisition?.source ?? "none",
      campaign: acquisition?.campaign ?? "none",
    });
    // Fire once on land; acquisition is derived from the URL for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signup attribution snapshot
  }, []);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(
        REGISTRATION_PROFILE_STORAGE_KEY,
      );
      if (!raw) {
        return;
      }
      const saved = JSON.parse(raw) as {
        stage?: unknown;
        clinicModel?: unknown;
        firstGoal?: unknown;
      };
      if (
        typeof saved.clinicModel === "string" &&
        CLINIC_MODELS.includes(saved.clinicModel as ClinicModel)
      ) {
        setClinicModel(saved.clinicModel as ClinicModel);
      }
      if (
        typeof saved.firstGoal === "string" &&
        FIRST_GOALS.includes(saved.firstGoal as FirstGoal)
      ) {
        setFirstGoal(saved.firstGoal as FirstGoal);
      }
      if (
        saved.stage === "workflow" ||
        saved.stage === "preview" ||
        saved.stage === "account"
      ) {
        // Practice name and email intentionally stay out of sessionStorage.
        // A refresh from the security step returns to the identity step so the
        // user can re-enter them instead of landing on a hidden invalid state.
        setStage("workflow");
      }
    } catch {
      window.sessionStorage.removeItem(REGISTRATION_PROFILE_STORAGE_KEY);
    } finally {
      setProfileRestored(true);
    }
  }, []);

  useEffect(() => {
    if (!profileRestored) return;
    try {
      window.sessionStorage.setItem(
        REGISTRATION_PROFILE_STORAGE_KEY,
        JSON.stringify({ stage, clinicModel, firstGoal }),
      );
    } catch {
      // Session continuity is helpful but must never block registration.
    }
  }, [profileRestored, stage, clinicModel, firstGoal]);

  useEffect(() => {
    if (!profileRestored) return;
    if (stage === "workflow" || stage === "preview") return;
    trackFunnelEvent(
      stage === "profile"
        ? FUNNEL_EVENTS.signupProfileViewed
        : FUNNEL_EVENTS.signupAccountViewed,
      {
        source: acquisition?.source ?? "none",
        step: stage,
      },
    );
  }, [acquisition?.source, profileRestored, stage]);

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: async (data) => {
      trackFunnelEvent(FUNNEL_EVENTS.signupSucceeded, {
        model: clinicModel,
        goal: firstGoal,
        step: "account",
      });
      try {
        window.sessionStorage.removeItem(REGISTRATION_PROFILE_STORAGE_KEY);
      } catch {
        // The account is created even when storage is unavailable.
      }
      if (data.checkoutUrl) {
        if (!isSafeCheckoutRedirectUrl(data.checkoutUrl)) {
          toast.error("Hosted checkout is unavailable. Please try again.");
          setLoading(false);
          return;
        }
        window.location.href = data.checkoutUrl;
        return;
      }

      // No checkout wall: card-free hosted trials and self-host both sign in and
      // land in the app immediately. (A legacy card-up-front flow would have
      // returned a checkoutUrl above and never reached here.)
      const result = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
      });
      if (result?.ok) {
        // Full document navigation, NOT router.push: the logo link prefetched
        // "/" while logged out, so the router cache holds a redirect to
        // /login for up to 30s and push would replay it, bouncing brand-new
        // accounts to the login page right after signup.
        window.location.assign(nextPath);
      } else {
        toast.success("Account created. Please sign in.");
        router.push(`/login?next=${encodeURIComponent(nextPath)}`);
      }
    },
    onError: (err) => {
      toast.error(err.message);
      setError(err.message);
      setLoading(false);
    },
  });

  function validate(): string | null {
    if (practiceName.trim().length < 2)
      return "Add your practice name to continue.";
    if (practiceName.trim().length > AUTH_PRACTICE_NAME_MAX_LENGTH)
      return `Practice name must be at most ${AUTH_PRACTICE_NAME_MAX_LENGTH} characters.`;
    if (!isAuthEmailLengthValid(email))
      return `Email must be at most ${AUTH_EMAIL_MAX_LENGTH} characters.`;
    if (!isValidEmail(email)) return "Add a valid work email.";
    if (!country) return "Choose your clinic country.";
    if (country === "OTHER")
      return "Hosted workspaces are not available in your country yet.";
    if (password.length < AUTH_PASSWORD_MIN_LENGTH)
      return `Use at least ${AUTH_PASSWORD_MIN_LENGTH} characters for the password.`;
    if (password.length > AUTH_PASSWORD_MAX_LENGTH)
      return `Use at most ${AUTH_PASSWORD_MAX_LENGTH} characters for the password.`;
    return null;
  }

  const canSubmit =
    isRequiredAuthTextValid(practiceName, AUTH_PRACTICE_NAME_MAX_LENGTH, 2) &&
    isAuthEmailLengthValid(email) &&
    isValidEmail(email) &&
    country !== "" &&
    country !== "OTHER" &&
    password.length >= AUTH_PASSWORD_MIN_LENGTH &&
    password.length <= AUTH_PASSWORD_MAX_LENGTH;

  const canContinueFromWorkflow =
    isRequiredAuthTextValid(practiceName, AUTH_PRACTICE_NAME_MAX_LENGTH, 2) &&
    isAuthEmailLengthValid(email) &&
    isValidEmail(email);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    setError("");
    setLoading(true);
    trackFunnelEvent(FUNNEL_EVENTS.signupSubmitted, {
      model: clinicModel,
      goal: firstGoal,
      step: "account",
    });
    const registrationAcquisition = acquisitionWithFunnelVisitorId(
      acquisition,
      getFunnelVisitorId(),
    );
    registerMutation.mutate({
      email: email.trim().toLowerCase(),
      password,
      practiceName: practiceName.trim(),
      country: country as ClinicRegionCode,
      onboardingDraft: { clinicModel, firstGoal },
      acquisition: registrationAcquisition,
    });
  }

  function selectClinicModel(model: ClinicModel) {
    const nextGoal =
      model === "exploring" || firstGoal !== "self_host"
        ? firstGoal
        : "explore_sample";
    setClinicModel(model);
    setFirstGoal(nextGoal);
    trackFunnelEvent(FUNNEL_EVENTS.onboardingModelSelected, {
      model,
      step: "profile",
    });
  }

  function selectFirstGoal(goal: FirstGoal) {
    setFirstGoal(goal);
    trackFunnelEvent(FUNNEL_EVENTS.onboardingGoalSelected, {
      model: clinicModel,
      goal,
      step: "workflow",
    });
  }

  function showStage(nextStage: RegistrationStage) {
    window.scrollTo({ top: 0, behavior: "auto" });
    setStage(nextStage);
  }

  function continueToWorkflow() {
    setError("");
    showStage("workflow");
  }

  function continueToPreview() {
    if (!canContinueFromWorkflow) {
      setError(
        practiceName.trim().length < 2
          ? "Add your practice name to continue."
          : "Add a valid work email.",
      );
      return;
    }
    setError("");
    trackFunnelEvent(FUNNEL_EVENTS.signupProfileCompleted, {
      model: clinicModel,
      goal: firstGoal,
      step: "workflow",
    });
    trackFunnelEvent(FUNNEL_EVENTS.onboardingPlanBuilt, {
      model: clinicModel,
      goal: firstGoal,
      step: "workflow",
    });
    showStage("preview");
  }

  function continueToAccount() {
    setError("");
    showStage("account");
  }

  if (stage === "profile") {
    return (
      <main className={onboardingStageMainClass}>
        <div className={onboardingStageFrameClass}>
          <header className={onboardingStageHeaderClass}>
            <Link
              href="/"
              className="inline-flex items-center gap-3 font-heading text-lg font-semibold tracking-tight text-slate-950 sm:text-xl"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <PawMark className="h-5 w-5" />
              </span>
              OpenVPM
            </Link>
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 sm:gap-3 sm:text-sm">
              <span className="whitespace-nowrap">Step 1 of 4</span>
              <span className="flex gap-1" aria-hidden="true">
                <span className="h-1.5 w-6 rounded-full bg-primary sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-slate-200 sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-slate-200 sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-slate-200 sm:w-10" />
              </span>
            </div>
          </header>

          <section className="flex-1 px-5 py-7 sm:px-9 sm:py-10 lg:px-12">
            <div className="mb-8 max-w-3xl">
              <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
                A platform truly built for your clinic.
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
                Tell us what your team needs first. We’ll shape a useful first
                day before asking you to create the workspace.
              </p>
            </div>

            <ClinicIntentBuilder
              clinicModel={clinicModel}
              firstGoal={firstGoal}
              onClinicModelChange={selectClinicModel}
              onFirstGoalChange={selectFirstGoal}
              intro={null}
              showFirstGoal={false}
            />
          </section>

          <footer className={cn(onboardingStageFooterClass, "sm:justify-end")}>
            <Button
              type="button"
              onClick={continueToWorkflow}
              className="h-11 rounded-xl px-6 text-sm font-semibold shadow-[0_12px_28px_-16px_rgba(5,150,105,0.8)]"
            >
              Show my workflows
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </footer>
        </div>
      </main>
    );
  }

  if (stage === "workflow") {
    return (
      <main className={onboardingStageMainClass}>
        <div className={onboardingStageFrameClass}>
          <header className={onboardingStageHeaderClass}>
            <Link
              href="/"
              className="inline-flex items-center gap-3 font-heading text-lg font-semibold tracking-tight text-slate-950 sm:text-xl"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <PawMark className="h-5 w-5" />
              </span>
              OpenVPM
            </Link>
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 sm:gap-3 sm:text-sm">
              <span className="whitespace-nowrap">Step 2 of 4</span>
              <span className="flex gap-1" aria-hidden="true">
                <span className="h-1.5 w-6 rounded-full bg-primary sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-primary sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-slate-200 sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-slate-200 sm:w-10" />
              </span>
            </div>
          </header>

          <section className="flex-1 px-5 py-6 sm:px-9 sm:py-7 lg:px-10">
            <ClinicIntentBuilder
              clinicModel={clinicModel}
              firstGoal={firstGoal}
              onClinicModelChange={selectClinicModel}
              onFirstGoalChange={selectFirstGoal}
              intro={null}
              showClinicModel={false}
              goalLegend="Choose your first useful workflow"
              beforeChoices={
                <div className="max-w-3xl">
                  <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
                    What would you like to see?
                  </h1>
                  <p className="mt-2 text-sm leading-6 text-slate-600 sm:text-base">
                    Pick one useful workflow and we’ll shape your first day
                    around it.
                  </p>
                </div>
              }
              afterChoices={
                <div className="mt-5 border-t border-slate-100 pt-5">
                  <p className="text-sm font-semibold text-slate-950 sm:text-base">
                    Start your workspace
                  </p>

                  {error ? (
                    <div className="mt-4 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                      {error}
                    </div>
                  ) : null}

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <FormField label="Practice name" htmlFor="practiceName">
                      <Input
                        id="practiceName"
                        name="practiceName"
                        value={practiceName}
                        onChange={(event) => {
                          setPracticeName(event.target.value);
                          setError("");
                        }}
                        placeholder="Neighborhood Veterinary"
                        autoComplete="organization"
                        autoFocus
                        maxLength={AUTH_PRACTICE_NAME_MAX_LENGTH}
                        required
                      />
                    </FormField>
                    <FormField label="Work email" htmlFor="email">
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        value={email}
                        onChange={(event) => {
                          setEmail(event.target.value);
                          setError("");
                        }}
                        placeholder="you@clinic.com"
                        autoComplete="email"
                        maxLength={AUTH_EMAIL_MAX_LENGTH}
                        required
                      />
                    </FormField>
                  </div>
                </div>
              }
            />
          </section>

          <footer className={onboardingStageFooterClass}>
            <button
              type="button"
              onClick={() => {
                setError("");
                showStage("profile");
              }}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-primary"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <Button
              type="button"
              onClick={continueToPreview}
              className="h-11 rounded-xl px-6 text-sm font-semibold shadow-[0_12px_28px_-16px_rgba(5,150,105,0.8)]"
            >
              See my first day
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </footer>
        </div>
      </main>
    );
  }

  if (stage === "preview") {
    return (
      <main className={onboardingStageMainClass}>
        <div className={onboardingStageFrameClass}>
          <header className={onboardingStageHeaderClass}>
            <Link
              href="/"
              className="inline-flex items-center gap-3 font-heading text-lg font-semibold tracking-tight text-slate-950 sm:text-xl"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <PawMark className="h-5 w-5" />
              </span>
              OpenVPM
            </Link>
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 sm:gap-3 sm:text-sm">
              <span className="whitespace-nowrap">Step 3 of 4</span>
              <span className="flex gap-1" aria-hidden="true">
                <span className="h-1.5 w-6 rounded-full bg-primary sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-primary sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-primary sm:w-10" />
                <span className="h-1.5 w-6 rounded-full bg-slate-200 sm:w-10" />
              </span>
            </div>
          </header>

          <section className="flex-1 px-5 py-6 sm:px-9 sm:py-7 lg:px-10">
            <div className="mb-6 max-w-3xl">
              <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
                Your first day is ready.
              </h1>
              <p className="mt-3 text-sm leading-6 text-slate-600 sm:text-base">
                Here’s a useful starting point for {practiceName.trim()}. You
                can change any of it once you’re inside.
              </p>
            </div>

            <FirstDayRecommendations primaryGoal={firstGoal} />
          </section>

          <footer className={onboardingStageFooterClass}>
            <button
              type="button"
              onClick={() => showStage("workflow")}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-primary"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-4">
              <p className="text-center text-xs text-slate-500">
                No card required.
              </p>
              <Button
                type="button"
                onClick={continueToAccount}
                className="h-11 rounded-xl px-6 text-sm font-semibold shadow-[0_12px_28px_-16px_rgba(5,150,105,0.8)]"
              >
                Secure my workspace
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </footer>
        </div>
      </main>
    );
  }

  return (
    <div className="grid min-h-screen min-w-0 overflow-x-hidden lg:grid-cols-2">
      {/* Left pane: the form, on clean white */}
      <div className="flex min-w-0 items-start justify-center bg-white px-6 py-10 sm:px-10">
        <div className="min-w-0 w-full max-w-md">
          <div className="flex items-center justify-between gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-primary"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <PawMark className="h-4 w-4" />
              </span>
              OpenVPM {cloudIntent ? "Cloud" : ""}
            </Link>
            <span className="text-xs font-medium text-slate-500">
              Step 4 of 4
            </span>
          </div>

          <h1 className="mt-8 font-heading text-3xl font-bold tracking-tight text-slate-950">
            Secure your workspace.
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            One final step. Choose your clinic country and create a password. No
            card required.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 grid min-w-0 gap-4">
            {error ? (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="rounded-xl border border-emerald-100 bg-emerald-50/70 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-emerald-700">
                Your workspace
              </p>
              <p className="mt-1 truncate text-sm font-semibold text-slate-950">
                {practiceName.trim()}
              </p>
              <p className="mt-0.5 truncate text-xs text-slate-600">
                {email.trim().toLowerCase()}
              </p>
            </div>

            <input
              type="email"
              name="email"
              value={email.trim().toLowerCase()}
              autoComplete="username"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              readOnly
            />

            <FormField
              label="Clinic country"
              htmlFor="country"
              className="min-w-0"
              description="This sets your currency, tax defaults, time zone, and rollout eligibility."
            >
              <select
                id="country"
                name="country"
                className={selectClass}
                value={country}
                autoComplete="country"
                onChange={(event) => {
                  setCountry(event.target.value as RegistrationCountry);
                  setError("");
                }}
                required
              >
                <option value="">Choose your clinic country</option>
                {CLINIC_REGION_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
                <option value="OTHER">Another country</option>
              </select>
            </FormField>

            {country && country !== "US" && country !== "OTHER" ? (
              <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  OpenVPM can format this workspace for your region, but the
                  supported design-partner rollout is currently limited to US
                  clinics. Explore with sample data only; do not move live
                  clinic work yet.
                </p>
              </div>
            ) : null}

            {country === "OTHER" ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-700">
                Hosted workspaces are not available in your country yet. You can
                still{" "}
                <a
                  href="https://demo.openvpm.com"
                  className="font-medium text-primary underline underline-offset-2"
                >
                  explore the immediate demo
                </a>{" "}
                or review the{" "}
                <a
                  href="https://github.com/evangauer/openvpm"
                  className="font-medium text-primary underline underline-offset-2"
                >
                  self-hosted project
                </a>
                .
              </div>
            ) : null}

            <FormField
              label="Password"
              htmlFor="password"
              className="min-w-0"
              description={`At least ${AUTH_PASSWORD_MIN_LENGTH} characters.`}
            >
              <Input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Create a password"
                autoComplete="new-password"
                minLength={AUTH_PASSWORD_MIN_LENGTH}
                maxLength={AUTH_PASSWORD_MAX_LENGTH}
                required
              />
            </FormField>

            <Button
              type="submit"
              disabled={!canSubmit || loading || registerMutation.isPending}
              className="mt-1 w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating your workspace
                </>
              ) : (
                <>
                  Start my free trial
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>

            <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              Free for 14 days. No credit card required.
            </p>

            <button
              type="button"
              onClick={() => showStage("preview")}
              className="mx-auto inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to my first day
            </button>

            <p className="text-center text-xs text-slate-400">
              By creating a workspace you agree to the{" "}
              <Link
                href="/legal/terms"
                className="underline underline-offset-2 hover:text-slate-600"
              >
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link
                href="/legal/privacy"
                className="underline underline-offset-2 hover:text-slate-600"
              >
                Privacy Policy
              </Link>
              .
            </p>
          </form>

          <p className="mt-8 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link
              href={`/login?next=${encodeURIComponent(nextPath)}`}
              className="font-medium text-primary hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>

      {/* Right pane: gradient, with the platform flush to the bottom-right edge */}
      <div className="relative hidden overflow-hidden bg-[linear-gradient(135deg,#fff7ed_0%,#fdf2f8_45%,#ecfdf5_100%)] lg:block">
        <div className="relative z-10 px-12 pt-16">
          <h2 className="max-w-md font-heading text-3xl font-bold tracking-tight text-slate-950">
            Your first day, already taking shape.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-600">
            Built around{" "}
            {clinicModelOption(clinicModel).shortLabel.toLowerCase()} care and
            the first outcome you chose. You can change any of it once you’re
            inside.
          </p>
        </div>

        <div className="absolute bottom-0 right-0 left-16 top-52">
          <PlatformPreview practiceName={practiceName} />
        </div>
      </div>
    </div>
  );
}

const NAV = [
  { label: "Dashboard", icon: LayoutDashboard },
  { label: "Patients", icon: PawPrint },
  { label: "Schedule", icon: Calendar },
  { label: "Records", icon: FileText },
  { label: "Billing", icon: Receipt },
  { label: "Inventory", icon: Package },
];

const KPIS = [
  { label: "Today's visits", value: "8", icon: Calendar },
  { label: "New patients", value: "3", icon: PawPrint },
  { label: "Revenue", value: "$1,240", icon: Receipt },
];

// Appointment colors mirror the real schedule.
const APPTS = [
  { time: "9:00", title: "Wellness exam", pet: "Biscuit", color: "#0d9488" },
  { time: "10:30", title: "Vaccination", pet: "Luna", color: "#2563eb" },
  { time: "1:15", title: "Dental cleaning", pet: "Mango", color: "#0891b2" },
  { time: "3:00", title: "Sick visit", pet: "Olive", color: "#dc2626" },
];

/**
 * A clean, value-first snapshot of the real app: the icon side nav, the
 * dashboard value cards, the day's schedule with appointment colors, and an
 * Ask AI card. Rendered flush to the bottom-right edge of the pane.
 */
function PlatformPreview({ practiceName }: { practiceName: string }) {
  const clinic = practiceName.trim() || "Neighborhood Veterinary";
  return (
    <div className="h-full w-full overflow-hidden rounded-tl-2xl border-l border-t border-white/80 bg-white shadow-2xl shadow-rose-200/40">
      <div className="flex h-full">
        {/* Side nav */}
        <aside className="flex w-[150px] shrink-0 flex-col border-r border-slate-100 bg-slate-50/70 p-3">
          <div className="flex items-center gap-2 px-1 pb-4">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-semibold text-primary-foreground">
              {initials(clinic)}
            </span>
            <span className="truncate font-heading text-sm font-semibold text-slate-900">
              {clinic}
            </span>
          </div>
          <nav className="space-y-1">
            {NAV.map(({ label, icon: Icon }, i) => (
              <div
                key={label}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs font-medium",
                  i === 0 ? "bg-primary/10 text-primary" : "text-slate-500",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </div>
            ))}
          </nav>
          <div className="mt-auto flex items-center gap-2 px-1 pt-3">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
              DV
            </span>
            <span className="truncate text-[11px] text-slate-500">Dr. Vet</span>
          </div>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="font-heading text-sm font-semibold text-slate-900">
              Dashboard
            </p>
            <span className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground">
              New
            </span>
          </div>

          <div className="flex-1 space-y-3 p-4">
            {/* Value cards */}
            <div className="grid grid-cols-3 gap-3">
              {KPIS.map(({ label, value, icon: Icon }) => (
                <div
                  key={label}
                  className="rounded-lg border border-slate-100 bg-white p-3"
                >
                  <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                    {label}
                  </p>
                  <p className="text-base font-semibold text-slate-950">
                    {value}
                  </p>
                </div>
              ))}
            </div>

            {/* Today's schedule with appointment colors */}
            <div className="rounded-lg border border-slate-100 p-3">
              <p className="text-xs font-semibold text-slate-900">
                Today's schedule
              </p>
              <div className="mt-2 space-y-1.5">
                {APPTS.map((a) => (
                  <div
                    key={a.time}
                    className="flex items-center gap-3 rounded-md px-2.5 py-1.5"
                    style={{ backgroundColor: `${a.color}14` }}
                  >
                    <span className="w-10 text-[11px] font-medium text-slate-500">
                      {a.time}
                    </span>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: a.color }}
                    />
                    <span className="text-xs font-medium text-slate-900">
                      {a.title}
                    </span>
                    <span className="ml-auto text-[11px] text-slate-500">
                      {a.pet}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Ask AI */}
            <div className="rounded-lg border border-slate-100 bg-primary/5 p-3">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="h-3.5 w-3.5" />
                </span>
                <p className="text-xs font-semibold text-slate-900">Ask AI</p>
              </div>
              <div className="mt-2 flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
                <span className="truncate text-[11px] text-slate-500">
                  Which pets are due for vaccines?
                </span>
                <span className="ml-auto rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
                  Ask
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
