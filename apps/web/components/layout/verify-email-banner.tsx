"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Mail, X, Loader2, Check } from "lucide-react";
import { trpc } from "@/lib/trpc";

const DISMISS_KEY = "ovpm_verify_email_dismissed";

/**
 * Soft email-verification nudge. Verification is NOT a gate (signup lands
 * straight in the trial); this is a non-blocking reminder shown only on the
 * hosted service while the signed-in user's email is unverified. Dismissible
 * for the session, with a one-click resend.
 */
export function VerifyEmailBanner() {
  const [dismissed, setDismissed] = useState(true); // assume dismissed until we read storage
  const { data, isLoading, error, refetch } = trpc.auth.me.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const resend = trpc.auth.resendVerification.useMutation();

  useEffect(() => {
    setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
  }, []);

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  if (dismissed) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-amber-900">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <p className="flex-1">Checking email verification status...</p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="rounded p-1 text-amber-700 hover:bg-amber-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/5 px-6 py-2.5 text-sm text-destructive">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <p className="flex-1">Unable to check email verification status.</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-background px-2.5 py-1 text-xs font-medium hover:bg-destructive/10"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="rounded p-1 hover:bg-destructive/10"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (!data.verificationEnabled || data.emailVerified) return null;

  const showResendAction =
    !resend.isSuccess ||
    Boolean(
      resend.data &&
      !resend.data.alreadyVerified &&
      !resend.data.verificationEmailSent &&
      !resend.data.verificationEmailPreviewed &&
      !resend.data.possiblySent,
    );

  return (
    // Wraps at phone widths so the resend button never clips off-screen.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 sm:px-6">
      <Mail className="hidden h-4 w-4 shrink-0 sm:block" />
      <p className="min-w-0 flex-1 basis-48">
        {resend.isSuccess && resend.data ? (
          <span className="inline-flex items-center gap-1.5">
            {resend.data.verificationEmailSent ||
            resend.data.verificationEmailPreviewed ? (
              <Check className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            {resend.data.message}
          </span>
        ) : (
          <>
            Verify your email{data.email ? ` (${data.email})` : ""} to secure
            your account and keep reminders deliverable.
          </>
        )}
        {resend.error ? (
          <span className="mt-1 block text-xs text-destructive">
            {resend.error.message}
          </span>
        ) : null}
      </p>
      {showResendAction && (
        <button
          type="button"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          {resend.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          Resend email
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-1 text-amber-700 hover:bg-amber-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
