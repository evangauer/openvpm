"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AUTH_EMAIL_MAX_LENGTH,
  isAuthEmailLengthValid,
} from "@/lib/auth-input-policy";
import { AUTH_PASSWORD_MAX_LENGTH } from "@/lib/auth-password-policy";
import { PawMark } from "@/components/brand/paw-mark";
import { isValidEmail } from "@/lib/utils";
import {
  buildCloudSignupUrl,
  cloudSignupAppOrigin,
  FUNNEL_EVENTS,
} from "@/lib/funnel-analytics";
import { trackFunnelEvent } from "@/lib/track-funnel-event";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE?.trim() === "true";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <LoginPageInner />
    </Suspense>
  );
}

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (
    value.startsWith("/login") ||
    value.startsWith("/register") ||
    value.startsWith("/verify-email")
  ) {
    return "/";
  }
  return value;
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeNextPath(searchParams.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const passwordMeetsPolicy =
    password.length > 0 && password.length <= AUTH_PASSWORD_MAX_LENGTH;
  const emailIsValid =
    isAuthEmailLengthValid(email) && isValidEmail(email);
  const canSubmit =
    emailIsValid && (DEMO_MODE || passwordMeetsPolicy);

  useEffect(() => {
    if (!DEMO_MODE) return;
    trackFunnelEvent(FUNNEL_EVENTS.demoLand);
    trackFunnelEvent(FUNNEL_EVENTS.demoGateViewed);
  }, []);

  async function signInWith(emailValue: string, passwordValue: string) {
    setError("");
    setLoading(true);
    setEmail(emailValue);
    setPassword(passwordValue);

    const result = await signIn("credentials", {
      email: emailValue,
      password: passwordValue,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email or password");
    } else {
      router.push(nextPath);
      router.refresh();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    if (DEMO_MODE) {
      setError("");
      setLoading(true);

      try {
        const gateResponse = await fetch("/api/demo-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim().toLowerCase() }),
        });
        const gateResult = (await gateResponse.json().catch(() => null)) as
          | { ok?: boolean; error?: string }
          | null;
        if (!gateResponse.ok || !gateResult?.ok) {
          setError(gateResult?.error ?? "The demo is temporarily unavailable.");
          return;
        }

        trackFunnelEvent(FUNNEL_EVENTS.demoGateSubmitted);
        const result = await signIn("demo", {
          role: "admin",
          redirect: false,
        });
        if (result?.error) {
          setError("The demo is temporarily unavailable.");
          return;
        }

        router.push(nextPath);
        router.refresh();
      } catch {
        setError("The demo is temporarily unavailable.");
      } finally {
        setLoading(false);
      }
      return;
    }

    await signInWith(email.trim().toLowerCase(), password);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <PawMark className="h-6 w-6" />
          </span>
          <h1 className="font-heading text-2xl font-bold text-foreground">
            OpenVPM
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {DEMO_MODE ? "Explore the live product" : "Sign in to your practice"}
          </p>
        </div>

        {DEMO_MODE && (
          <div className="mb-6 rounded-md border border-primary/20 bg-primary/5 p-4">
            <p className="mb-1 text-sm font-semibold text-foreground">
              Immediate access to the live demo
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              No call, sales form, or credit card. We use your email to protect
              this shared sandbox from automated abuse. We may send one brief
              email asking what you thought; unsubscribe anytime.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-sm font-medium text-foreground"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={AUTH_EMAIL_MAX_LENGTH}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="you@clinic.com"
              autoComplete="email"
            />
          </div>

          {!DEMO_MODE && (
            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                maxLength={AUTH_PASSWORD_MAX_LENGTH}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit || loading}
            className="min-h-11 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading
              ? DEMO_MODE
                ? "Opening demo..."
                : "Signing in..."
              : DEMO_MODE
                ? "Open the live demo"
                : "Sign in"}
          </button>
        </form>

        {!DEMO_MODE && (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link
              href="/forgot-password"
              className="text-primary hover:underline"
            >
              Forgot your password?
            </Link>
          </p>
        )}
        <p className="mt-2 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          {DEMO_MODE ? (
            <a
              href={buildCloudSignupUrl({
                appOrigin: cloudSignupAppOrigin(),
                source: "demo",
                medium: "product",
                campaign: "demo_login",
              })}
              onClick={() =>
                trackFunnelEvent(FUNNEL_EVENTS.demoCtaStartClinic, {
                  tool: "login",
                  path: "/login",
                })
              }
              className="text-primary hover:underline"
            >
              Start my clinic
            </a>
          ) : (
            <Link href="/register" className="text-primary hover:underline">
              Register your practice
            </Link>
          )}
        </p>
      </div>
    </div>
  );
}
