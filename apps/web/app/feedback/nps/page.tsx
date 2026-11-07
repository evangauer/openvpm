import type { Metadata } from "next";
import Link from "next/link";
import { BrandBadge } from "@/components/brand/paw-mark";
import { openvpmBrand } from "@openpims/email";
import {
  isNpsScore,
  npsCategory,
  NPS_COMMENT_MAX_LENGTH,
  type NpsCategory,
} from "@/lib/growth/customer-lifecycle";
import { verifyNpsToken } from "@/lib/growth/nps-token";

export const metadata: Metadata = {
  title: "How are we doing? - OpenVPM",
  robots: { index: false, follow: false },
};

const THANKS: Record<NpsCategory, string> = {
  promoter:
    "That means a lot. If a clinic you know is shopping for a new system, we'd love an introduction.",
  passive:
    "Thank you. If there's one thing that would make it a 10, reply to the email and tell us.",
  detractor:
    "Thank you for being straight with us. A person from OpenVPM will reach out to hear what's not working.",
};

function param(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function scoreParam(value: string): number | null {
  if (!/^\d{1,2}$/.test(value)) return null;
  const score = Number(value);
  return isNpsScore(score) ? score : null;
}

/**
 * Landing page for the one-click NPS scores in email. Opening the link only
 * preselects a score; saving takes a deliberate submit so link scanners that
 * prefetch every URL never record an answer.
 */
export default async function NpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = param(params.token);
  const preselected = scoreParam(param(params.score));
  const saved = scoreParam(param(params.saved));
  const valid = verifyNpsToken(token) != null;
  const supportEmail = openvpmBrand().supportEmail;

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-surface px-4 py-12"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <Link
          href="/"
          className="inline-flex items-center gap-2.5 text-foreground"
        >
          <BrandBadge className="h-9 w-9 rounded-xl" pawClassName="h-5 w-5" />
          <span className="font-heading text-lg font-semibold tracking-tight">
            OpenVPM
          </span>
        </Link>

        {!valid ? (
          <div className="mt-8 space-y-3">
            <h1 className="font-heading text-2xl font-semibold">
              This link has expired
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              We&apos;d still love to hear from you at{" "}
              <a className="underline" href={`mailto:${supportEmail}`}>
                {supportEmail}
              </a>
              .
            </p>
          </div>
        ) : saved !== null ? (
          <div className="mt-8 space-y-3">
            <h1 className="font-heading text-2xl font-semibold">
              Thank you
            </h1>
            <p className="text-sm leading-6 text-muted-foreground">
              {THANKS[npsCategory(saved)]}
            </p>
          </div>
        ) : (
          <form method="post" action="/api/growth/nps" className="mt-8 space-y-5">
            <div className="space-y-2">
              <h1 className="font-heading text-2xl font-semibold">
                How likely are you to recommend OpenVPM to another clinic?
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                0 is not at all likely, 10 is extremely likely.
              </p>
            </div>
            <input type="hidden" name="token" value={token} />
            <fieldset className="grid grid-cols-11 gap-1">
              <legend className="sr-only">Score</legend>
              {Array.from({ length: 11 }, (_, score) => (
                <label
                  key={score}
                  className="flex h-10 cursor-pointer items-center justify-center rounded-lg border border-border text-sm font-semibold hover:bg-muted/40 has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-primary-foreground"
                >
                  <input
                    type="radio"
                    name="score"
                    value={score}
                    required
                    defaultChecked={score === preselected}
                    className="sr-only"
                  />
                  {score}
                </label>
              ))}
            </fieldset>
            <label className="block space-y-1.5 text-sm">
              <span className="text-muted-foreground">
                What&apos;s the main reason for your score? (optional)
              </span>
              <textarea
                name="comment"
                rows={3}
                maxLength={NPS_COMMENT_MAX_LENGTH}
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
