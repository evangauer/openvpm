"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
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
import { acquisitionFromSearchParams } from "@/lib/acquisition";
import { FUNNEL_EVENTS } from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";

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
  const acquisition = acquisitionFromSearchParams(searchParams);
  const [practiceName, setPracticeName] = useState("");
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

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: async (data) => {
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
        window.location.assign("/");
      } else {
        toast.success("Account created. Please sign in.");
        router.push("/login");
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
    if (password.length < AUTH_PASSWORD_MIN_LENGTH)
      return `Use at least ${AUTH_PASSWORD_MIN_LENGTH} characters for the password.`;
    if (password.length > AUTH_PASSWORD_MAX_LENGTH)
      return `Use at most ${AUTH_PASSWORD_MAX_LENGTH} characters for the password.`;
    return null;
  }

  const canSubmit =
    isRequiredAuthTextValid(
      practiceName,
      AUTH_PRACTICE_NAME_MAX_LENGTH,
      2
    ) &&
    isAuthEmailLengthValid(email) &&
    isValidEmail(email) &&
    password.length >= AUTH_PASSWORD_MIN_LENGTH &&
    password.length <= AUTH_PASSWORD_MAX_LENGTH;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const message = validate();
    if (message) {
      setError(message);
      return;
    }
    setError("");
    setLoading(true);
    registerMutation.mutate({
      email: email.trim().toLowerCase(),
      password,
      practiceName: practiceName.trim(),
      acquisition,
    });
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left pane: the form, on clean white */}
      <div className="flex items-center justify-center bg-white px-6 py-10 sm:px-10">
        <div className="w-full max-w-md">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-primary"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <PawMark className="h-4 w-4" />
            </span>
            OpenVPM {cloudIntent ? "Cloud" : ""}
          </Link>

          <h1 className="mt-8 font-heading text-3xl font-bold tracking-tight text-slate-950">
            Create your workspace
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Start using OpenVPM in about a minute. You own your data, and smart
            AI tools are built in.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 grid gap-4">
            {error ? (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <FormField label="Practice name" htmlFor="practiceName">
              <Input
                id="practiceName"
                value={practiceName}
                onChange={(e) => setPracticeName(e.target.value)}
                placeholder="Neighborhood Veterinary"
                autoFocus
                maxLength={AUTH_PRACTICE_NAME_MAX_LENGTH}
                required
              />
            </FormField>

            <FormField label="Work email" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@clinic.com"
                maxLength={AUTH_EMAIL_MAX_LENGTH}
                required
              />
            </FormField>

            <FormField
              label="Password"
              htmlFor="password"
              description={`At least ${AUTH_PASSWORD_MIN_LENGTH} characters.`}
            >
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Create a password"
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
                  Create workspace
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>

            <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              Free for 14 days. No credit card required.
            </p>

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
            <Link href="/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>

      {/* Right pane: gradient, with the platform flush to the bottom-right edge */}
      <div className="relative hidden overflow-hidden bg-[linear-gradient(135deg,#fff7ed_0%,#fdf2f8_45%,#ecfdf5_100%)] lg:block">
        <div className="relative z-10 px-12 pt-16">
          <h2 className="max-w-md font-heading text-3xl font-bold tracking-tight text-slate-950">
            The practice system you own.
          </h2>
          <p className="mt-3 max-w-md text-sm leading-6 text-slate-600">
            Run your day, keep clean records, and send bills. Smart AI tools are
            built in, and your data stays yours to export any time.
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
                  i === 0 ? "bg-primary/10 text-primary" : "text-slate-500"
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
