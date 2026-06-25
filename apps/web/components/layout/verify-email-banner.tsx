"use client";

import { useEffect, useState } from "react";
import { Mail, X, Loader2, Check } from "lucide-react";
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
  const { data } = trpc.auth.me.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const resend = trpc.auth.resendVerification.useMutation();

  useEffect(() => {
    setDismissed(sessionStorage.getItem(DISMISS_KEY) === "1");
  }, []);

  if (dismissed) return null;
  if (!data?.verificationEnabled || data.emailVerified) return null;

  function dismiss() {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  }

  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-sm text-amber-900">
      <Mail className="h-4 w-4 shrink-0" />
      <p className="flex-1">
        {resend.isSuccess ? (
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-4 w-4" /> Verification email sent. Check your inbox (and spam).
          </span>
        ) : (
          <>
            Verify your email{data.email ? ` (${data.email})` : ""} to secure your
            account and keep reminders deliverable.
          </>
        )}
      </p>
      {!resend.isSuccess && (
        <button
          type="button"
          disabled={resend.isPending || !data.email}
          onClick={() => data.email && resend.mutate({ email: data.email })}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          {resend.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Resend email
        </button>
      )}
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
