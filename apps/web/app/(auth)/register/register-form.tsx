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
import { checkoutTrialSummary } from "@/lib/billing/checkout-summary";
import {
  acquisitionFromSearchParams,
  acquisitionWithFunnelVisitorId,
} from "@/lib/acquisition";
import { FUNNEL_EVENTS } from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";
import { getFunnelVisitorId } from "@/lib/funnel-visitor";
import { previewArmFor, type PreviewArm } from "@/lib/billing/preview";
import { usesClinicBuilder } from "@/lib/registration-entry";
import {
  CLINIC_REGION_OPTIONS,
  type ClinicRegionCode,
} from "@/lib/locale/clinic-regions";
import { safeAuthNextPath } from "@/lib/auth-redirect";

type RegistrationCountry = ClinicRegionCode | "OTHER" | "";
type RegistrationStage = "details" | "review";

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export interface RegisterFormProps {
  hostedBilling: boolean;
  cardRequired: boolean;
  trialDays: number;
  monthlyPriceUsd: number;
  /** Share of card-required signups that explore a preview before the card. */
  previewPercent?: number;
  /** Share of card-required signups sent through "Build your clinic". */
  builderPercent?: number;
}

export default function RegisterForm(props: RegisterFormProps) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-white">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <RegistrationEntry {...props} />
    </Suspense>
  );
}

/** Resolve browser-only attribution before mounting any registration UI or events. */
function RegistrationEntry(props: RegisterFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const funnelId =
      acquisitionFromSearchParams(searchParams)?.funnelId ?? getFunnelVisitorId();
    if (
      usesClinicBuilder({
        cardRequired: props.cardRequired,
        builderPercent: props.builderPercent ?? 0,
        funnelId,
      })
    ) {
      const params = new URLSearchParams(searchParams.toString());
      if (funnelId) params.set("funnel_id", funnelId);
      router.replace(`/start?${params.toString()}`);
    } else {
      setReady(true);
    }
  }, [props.cardRequired, props.builderPercent, router, searchParams]);
  if (!ready) {
    return (
      <div
        role="status"
        aria-label="Opening clinic setup"
        className="flex min-h-screen items-center justify-center bg-white"
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  return <RegisterPageInner {...props} />;
}

function RegisterPageInner({
  hostedBilling,
  cardRequired,
  trialDays,
  monthlyPriceUsd,
  previewPercent = 0,
}: RegisterFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cloudIntent = searchParams.get("intent") === "cloud";
  const nextPath = safeAuthNextPath(searchParams.get("next"), "/");
  const acquisition = acquisitionFromSearchParams(searchParams);
  const [stage, setStage] = useState<RegistrationStage>("details");
  const [practiceName, setPracticeName] = useState("");
  const [country, setCountry] = useState<RegistrationCountry>("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Mirrors the server's assignment from the same funnel id, so the copy
  // matches what registration will do.
  const [previewArm, setPreviewArm] = useState<PreviewArm>("control");
  useEffect(() => {
    if (!cardRequired || previewPercent <= 0) return;
    setPreviewArm(
      previewArmFor(
        acquisition?.funnelId ?? getFunnelVisitorId(),
        previewPercent,
      ),
    );
    // Assigned once per mount from the attribution snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable arm
  }, []);
  const previewFirst = cardRequired && previewArm === "preview";
  const cardFirst = cardRequired && !previewFirst;
  const trialSummary = checkoutTrialSummary({
    configuredPriceUsd: monthlyPriceUsd,
  });

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
    if (stage !== "details") return;
    trackFunnelEvent(FUNNEL_EVENTS.signupAccountViewed, {
      source: acquisition?.source ?? "none",
      step: "account",
    });
  }, [acquisition?.source, stage]);

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: async (data) => {
      trackFunnelEvent(FUNNEL_EVENTS.signupSucceeded, {
        step: "account",
      });
      if (data.checkoutUrl) {
        if (!isSafeCheckoutRedirectUrl(data.checkoutUrl)) {
          toast.error("Hosted checkout is unavailable. Please try again.");
          setLoading(false);
          return;
        }
        // The Checkout success page needs this browser's session. Sign in
        // before leaving for Stripe; if that fails, Checkout still opens and
        // the confirmation offers sign-in.
        try {
          await signIn("credentials", {
            email: email.trim().toLowerCase(),
            password,
            redirect: false,
          });
        } catch {
          // Checkout still proceeds.
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

  function startRegistration() {
    setError("");
    setLoading(true);
    trackFunnelEvent(FUNNEL_EVENTS.signupSubmitted, {
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
      acquisition: registrationAcquisition,
    });
  }

  function onDetailsSubmit(event: React.FormEvent) {
    event.preventDefault();
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    setError("");
    if (cardFirst) {
      window.scrollTo({ top: 0, behavior: "auto" });
      setStage("review");
      return;
    }
    startRegistration();
  }

  function onReviewSubmit(event: React.FormEvent) {
    event.preventDefault();
    const message = validate();
    if (message) {
      setError(message);
      setStage("details");
      return;
    }
    startRegistration();
  }

  if (stage === "review" && cardFirst) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-white px-4 py-10">
        <div className="w-full max-w-lg">
          <div className="flex items-center justify-between gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-primary"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <PawMark className="h-4 w-4" />
              </span>
              OpenVPM
            </Link>
            <span className="text-xs font-medium text-slate-500">
              Step 2 of 2
            </span>
          </div>
          <h1 className="mt-8 font-heading text-3xl font-bold tracking-tight text-slate-950">
            Confirm your trial, then checkout.
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {practiceName.trim()} · {email.trim().toLowerCase()}
          </p>
          <form onSubmit={onReviewSubmit} className="mt-8 grid gap-4">
            {error ? (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            <p className="rounded-md border border-emerald-100 bg-emerald-50/70 px-3 py-3 text-center text-sm font-medium text-slate-800">
              {trialSummary.text}
            </p>
            <p className="text-center text-sm text-slate-600">
              Card required. No charge today.
            </p>
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
                  Continue to secure checkout
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
            <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              Free for {trialDays} days.
            </p>
            <p className="text-center text-xs leading-5 text-slate-500">
              After your {trialDays}-day trial, ${monthlyPriceUsd} USD/month per
              active location, plus applicable taxes and usage overages.
              Billing starts automatically. Cancel in Settings → Plan &amp;
              Billing before the trial ends to avoid a subscription charge.
            </p>
            <TermsNotice />
            <button
              type="button"
              onClick={() => {
                setError("");
                setStage("details");
              }}
              className="mx-auto inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 transition hover:text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <div className="grid min-h-screen min-w-0 overflow-x-hidden lg:grid-cols-2">
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
            {cardFirst ? (
              <span className="text-xs font-medium text-slate-500">
                Step 1 of 2
              </span>
            ) : null}
          </div>

          <h1 className="mt-8 font-heading text-3xl font-bold tracking-tight text-slate-950">
            Create your clinic workspace.
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Practice name, work email, password, and country.
            {cardFirst
              ? " Next, confirm the trial date, then continue to Checkout."
              : previewFirst
                ? " Next, explore your workspace with sample data. Add a card when you're ready to start your free trial."
                : hostedBilling
                  ? " Your free trial starts immediately."
                  : " Your self-hosted workspace is free."}
          </p>

          <form onSubmit={onDetailsSubmit} className="mt-8 grid min-w-0 gap-4">
            {error ? (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

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
                onChange={(event) => setPassword(event.target.value)}
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
              ) : cardFirst ? (
                <>
                  Continue
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              ) : (
                <>
                  {previewFirst
                    ? "Build my workspace"
                    : hostedBilling
                      ? "Start my free trial"
                      : "Create my workspace"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>

            <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              {hostedBilling
                ? `Free for ${trialDays} days.`
                : "Free, open-source software."}
              {previewFirst
                ? " No card needed to look around."
                : cardFirst
                  ? " Card required. No charge today."
                  : hostedBilling
                    ? " No credit card required."
                    : ""}
            </p>

            {!cardFirst ? <TermsNotice /> : null}
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

      <div className="relative hidden overflow-hidden bg-[linear-gradient(135deg,#fff7ed_0%,#fdf2f8_45%,#ecfdf5_100%)] lg:block">
        <div className="relative z-10 px-12 pt-16">
          <h2 className="max-w-md font-heading text-3xl font-bold tracking-tight text-slate-950">
            Your clinic workspace, ready for the first day.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-600">
            Clinic model and first goal wait until setup, after you&apos;re
            signed in. You can change them once you&apos;re in.
          </p>
        </div>
        <div className="absolute bottom-0 right-0 left-16 top-52">
          <PlatformPreview practiceName={practiceName} />
        </div>
      </div>
    </div>
  );
}

function TermsNotice() {
  return (
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

            <div className="rounded-lg border border-slate-100 p-3">
              <p className="text-xs font-semibold text-slate-900">
                Today&apos;s schedule
              </p>
              <div className="mt-2 space-y-1.5">
                {APPTS.map((appointment) => (
                  <div
                    key={appointment.time}
                    className="flex items-center gap-3 rounded-md px-2.5 py-1.5"
                    style={{ backgroundColor: `${appointment.color}14` }}
                  >
                    <span className="w-10 text-[11px] font-medium text-slate-500">
                      {appointment.time}
                    </span>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: appointment.color }}
                    />
                    <span className="text-xs font-medium text-slate-900">
                      {appointment.title}
                    </span>
                    <span className="ml-auto text-[11px] text-slate-500">
                      {appointment.pet}
                    </span>
                  </div>
                ))}
              </div>
            </div>

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
