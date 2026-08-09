"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { MailCheck, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";

function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  // Token links confirm the address. Recovery is intentionally authenticated:
  // signed-in users can resend from the in-app banner without exposing an
  // email-address endpoint that could invalidate another user's link.
  if (token) return <ConfirmToken token={token} />;
  return <VerificationRecovery />;
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
            Email confirmed. Your trial was already active, so you can continue
            where you left off.
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
            href="/"
            className="mt-6 inline-block text-sm text-primary hover:underline"
          >
            Open OpenVPM to resend
          </Link>
        </>
      )}
    </Shell>
  );
}

function VerificationRecovery() {
  return (
    <Shell>
      <div className="mt-4 flex justify-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MailCheck className="h-6 w-6" />
        </span>
      </div>
      <h2 className="mt-4 font-heading text-lg font-semibold text-foreground">
        Confirm your email
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Your trial is already active. Open OpenVPM and use the verification
        banner to send a new link securely. Any unexpired verification link will
        work.
      </p>
      <Link
        href="/"
        className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Open OpenVPM
      </Link>
      <p className="mt-4 text-xs text-muted-foreground">
        If you&apos;re signed out, OpenVPM will ask you to sign in first.
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
