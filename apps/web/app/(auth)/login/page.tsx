"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AUTH_EMAIL_MAX_LENGTH,
  isAuthEmailLengthValid,
} from "@/lib/auth-input-policy";
import { AUTH_PASSWORD_MAX_LENGTH } from "@/lib/auth-password-policy";
import { PawMark } from "@/components/brand/paw-mark";
import { DemoLogin } from "@/components/demo/demo-login";
import { isValidEmail } from "@/lib/utils";
import { safeAuthNextPath } from "@/lib/auth-redirect";

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
      {DEMO_MODE ? <DemoLogin /> : <PracticeLogin />}
    </Suspense>
  );
}

function PracticeLogin() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = safeAuthNextPath(
    searchParams.get("next"),
    "/post-login",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const passwordMeetsPolicy =
    password.length > 0 && password.length <= AUTH_PASSWORD_MAX_LENGTH;
  const canSubmit =
    isAuthEmailLengthValid(email) && isValidEmail(email) && passwordMeetsPolicy;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit || loading) return;
    setError("");
    setLoading(true);
    try {
      const result = await signIn("credentials", {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
      });
      if (result?.error) {
        setError("Invalid email or password");
      } else if (result?.ok) {
        router.push(nextPath);
        router.refresh();
      } else {
        setError("Sign-in is temporarily unavailable. Please try again.");
      }
    } catch {
      setError("Sign-in is temporarily unavailable. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-surface p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <PawMark className="h-6 w-6" />
          </span>
          <h1 className="font-heading text-2xl font-bold text-foreground">
            OpenVPM
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to your practice
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive"
            >
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
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={AUTH_EMAIL_MAX_LENGTH}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="you@clinic.com"
              autoComplete="email"
            />
          </div>
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
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={AUTH_PASSWORD_MAX_LENGTH}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Enter your password"
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            disabled={!canSubmit || loading}
            className="min-h-11 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link
            href="/forgot-password"
            className="text-primary hover:underline"
          >
            Forgot your password?
          </Link>
        </p>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link
            href={
              nextPath === "/post-login"
                ? "/register"
                : `/register?next=${encodeURIComponent(nextPath)}`
            }
            className="text-primary hover:underline"
          >
            Register your practice
          </Link>
        </p>
      </div>
    </main>
  );
}
