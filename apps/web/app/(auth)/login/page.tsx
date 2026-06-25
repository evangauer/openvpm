"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

const DEMO_ROLES = [
  {
    label: "Admin",
    description: "Full access — everything a practice owner sees",
    email: "admin@neighborhoodvet.example.com",
    password: "password123",
  },
  {
    label: "Veterinarian",
    description: "Exam room, SOAP notes, prescriptions",
    email: "sarah.chen@neighborhoodvet.example.com",
    password: "password123",
  },
  {
    label: "Technician",
    description: "Treatments, lab workflow, whiteboard",
    email: "jamie.torres@neighborhoodvet.example.com",
    password: "password123",
  },
  {
    label: "Front Desk",
    description: "Scheduling, check-in, billing",
    email: "morgan.bailey@neighborhoodvet.example.com",
    password: "password123",
  },
];

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

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
  const [showVerifyHint, setShowVerifyHint] = useState(false);
  const [loading, setLoading] = useState(false);

  async function signInWith(emailValue: string, passwordValue: string) {
    setError("");
    setShowVerifyHint(false);
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
      // Unverified hosted accounts can't sign in yet — send them to the
      // "check your inbox" screen (with resend) instead of a dead-end error.
      if (result.error.includes("EMAIL_NOT_VERIFIED")) {
        router.push(`/verify-email?email=${encodeURIComponent(emailValue)}`);
        return;
      }
      setError("Invalid email or password.");
      setShowVerifyHint(true);
    } else {
      router.push(nextPath);
      router.refresh();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await signInWith(email, password);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8">
        <div className="mb-6 text-center">
          <h1 className="font-heading text-2xl font-bold text-foreground">
            OpenVPM
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to your practice
          </p>
        </div>

        {DEMO_MODE && (
          <div className="mb-6 rounded-md border border-primary/20 bg-primary/5 p-4">
            <p className="mb-1 text-sm font-semibold text-foreground">
              Try the demo — one click to log in
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              You&apos;re in the live OpenVPM demo. Pick a role to sign in instantly.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DEMO_ROLES.map((role) => (
                <button
                  key={role.email}
                  type="button"
                  onClick={() => signInWith(role.email, role.password)}
                  disabled={loading}
                  className="group flex flex-col rounded-md border border-border bg-background p-2.5 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
                >
                  <span className="text-sm font-medium text-foreground group-hover:text-primary">
                    Log in as {role.label}
                  </span>
                  <span className="mt-0.5 text-xs text-muted-foreground">
                    {role.description}
                  </span>
                </button>
              ))}
            </div>
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">
                View raw credentials
              </summary>
              <div className="mt-2 space-y-1 rounded border border-border bg-background p-2 font-mono">
                {DEMO_ROLES.map((role) => (
                  <div key={role.email} className="flex justify-between gap-2">
                    <span className="truncate">{role.email}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {role.password}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              <p>{error}</p>
              {showVerifyHint && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Just signed up?{" "}
                  <Link
                    href={`/verify-email?email=${encodeURIComponent(email)}`}
                    className="text-primary hover:underline"
                  >
                    Verify your email
                  </Link>{" "}
                  first.
                </p>
              )}
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
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="you@clinic.com"
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
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Enter your password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/forgot-password" className="text-primary hover:underline">
            Forgot your password?
          </Link>
        </p>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="text-primary hover:underline">
            Register your practice
          </Link>
        </p>
      </div>
    </div>
  );
}
