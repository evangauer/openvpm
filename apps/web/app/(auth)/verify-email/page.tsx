"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { MailCheck, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";

function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const email = params.get("email") ?? "";

  // Two modes: confirm a token (clicked from the email), or the post-signup
  // "check your inbox" pending screen (no token) with a resend option.
  if (token) return <ConfirmToken token={token} />;
  return <PendingVerification email={email} />;
}

function ConfirmToken({ token }: { token: string }) {
  const [status, setStatus] = useState<"verifying" | "ok" | "error">("verifying");
  const ran = useRef(false);

  const verify = trpc.auth.verifyEmail.useMutation({
    onSuccess: () => setStatus("ok"),
    onError: () => setStatus("error"),
  });

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    verify.mutate({ token });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <Shell>
      {status === "verifying" && (
        <p className="mt-3 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Verifying your email…
        </p>
      )}
      {status === "ok" && (
        <>
          <p className="mt-3 text-sm text-foreground">
            Your email is verified. Your OpenVPM trial is ready.
          </p>
          <Link
            href="/"
            className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open OpenVPM
          </Link>
        </>
      )}
      {status === "error" && (
        <>
          <p className="mt-3 text-sm text-destructive">
            This verification link is invalid or has expired.
          </p>
          <Link
            href="/verify-email"
            className="mt-6 inline-block text-sm text-primary hover:underline"
          >
            Send a new link
          </Link>
        </>
      )}
    </Shell>
  );
}

function PendingVerification({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  const resend = trpc.auth.resendVerification.useMutation({
    onSuccess: () => setSent(true),
  });

  return (
    <Shell>
      <div className="mt-4 flex justify-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MailCheck className="h-6 w-6" />
        </span>
      </div>
      <h2 className="mt-4 font-heading text-lg font-semibold text-foreground">
        Check your inbox
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {email ? (
          <>
            We sent a verification link to{" "}
            <span className="font-medium text-foreground">{email}</span>. Click it
            to confirm your address. Your trial is already active.
          </>
        ) : (
          <>
            We sent a verification link to your email. Click it to confirm your
            address. Your trial is already active.
          </>
        )}
      </p>

      {sent ? (
        <p className="mt-6 rounded-md border border-primary/20 bg-primary/5 p-3 text-sm text-primary">
          Sent. If it&apos;s not in your inbox, check spam.
        </p>
      ) : (
        <button
          type="button"
          disabled={!email || resend.isPending}
          onClick={() => email && resend.mutate({ email })}
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:border-primary hover:text-primary disabled:opacity-50"
        >
          {resend.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          Resend verification email
        </button>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        Wrong address?{" "}
        <Link href="/register" className="text-primary hover:underline">
          Use a different email
        </Link>
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Already verified?{" "}
        <Link href="/login" className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface p-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-8 text-center">
        <h1 className="font-heading text-2xl font-bold text-foreground">OpenVPM</h1>
        {children}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
