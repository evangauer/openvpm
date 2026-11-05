import type { Metadata } from "next";
import Link from "next/link";
import { openvpmBrand } from "@openpims/email";
import {
  isStopReason,
  STOP_REASON_LABELS,
  STOP_REASON_NOTE_MAX_LENGTH,
  STOP_REASONS,
  type StopReason,
} from "@/lib/growth/checkout-recovery";
import { verifyStopReasonToken } from "@/lib/growth/stop-reason-token";

export const metadata: Metadata = {
  title: "What got in the way? - OpenVPM",
  robots: { index: false, follow: false },
};

const FOLLOW_UP: Record<StopReason, string> = {
  card: "Your workspace is still saved. We'll reach out personally about getting you started.",
  price: "We'll reach out personally to talk through pricing for a clinic your size.",
  timing: "No pressure. Your workspace stays saved, and we won't send more setup reminders.",
  missing_feature: "We'll reach out personally to learn what you need and whether it's on the way.",
  self_host: "OpenVPM is open source, so you can run it yourself. The setup guide is in the repository README.",
  other: "We'll read your note and reach out personally.",
};

function param(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * Landing page for the one-click answers in recovery email. Opening the link
 * only preselects an answer; saving takes a deliberate submit so link
 * scanners that prefetch every URL never record a reason.
 */
export default async function StopReasonPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = param(params.token);
  const preselected = param(params.reason);
  const saved = param(params.saved);
  const valid = verifyStopReasonToken(token) != null;
  const supportEmail = openvpmBrand().supportEmail;

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-surface px-4 py-12"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <Link href="/" className="font-heading text-lg font-semibold">
          OpenVPM
        </Link>

        {!valid ? (
          <div className="mt-8 space-y-3">
            <h1 className="font-heading text-2xl font-semibold">
              This link has expired
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              You can still tell us what got in the way by writing to{" "}
              <a className="underline" href={`mailto:${supportEmail}`}>
                {supportEmail}
              </a>
              .
            </p>
          </div>
        ) : isStopReason(saved) ? (
          <div className="mt-8 space-y-3">
            <h1 className="font-heading text-2xl font-semibold">
              Thank you, that helps
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {FOLLOW_UP[saved]}
            </p>
            {saved === "self_host" ? (
              <a
                className="inline-block text-sm font-medium underline"
                href="https://github.com/evangauer/openvpm"
              >
                OpenVPM on GitHub
              </a>
            ) : null}
          </div>
        ) : (
          <form
            method="post"
            action="/api/growth/stop-reason"
            className="mt-8 space-y-5"
          >
            <div className="space-y-2">
              <h1 className="font-heading text-2xl font-semibold">
                What got in the way?
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                Your answer goes straight to the OpenVPM team, and a person
                will follow up.
              </p>
            </div>
            <input type="hidden" name="token" value={token} />
            <fieldset className="space-y-2">
              <legend className="sr-only">Reason</legend>
              {STOP_REASONS.map((reason) => (
                <label
                  key={reason}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-sm hover:bg-muted/40 has-[:checked]:border-primary"
                >
                  <input
                    type="radio"
                    name="reason"
                    value={reason}
                    required
                    defaultChecked={reason === preselected}
                  />
                  {STOP_REASON_LABELS[reason]}
                </label>
              ))}
            </fieldset>
            <label className="block space-y-1.5 text-sm">
              <span className="text-muted-foreground">
                Anything else we should know? (optional)
              </span>
              <textarea
                name="note"
                rows={3}
                maxLength={STOP_REASON_NOTE_MAX_LENGTH}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <button
              type="submit"
              className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Send
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
