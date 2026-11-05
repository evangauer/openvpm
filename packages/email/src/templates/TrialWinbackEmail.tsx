import * as React from "react";
import type { Brand } from "../brand";
import { A, P, PersonalNote } from "../components/PersonalNote";

export interface TrialWinbackEmailProps {
  brand: Brand;
  step: 1 | 2 | 3;
  practiceName: string;
  greetingName: string | null;
  senderName: string | null;
  /** e.g. "14 clients and 22 appointments"; null when nothing real was added. */
  usageSummary: string | null;
  reactivateUrl: string;
  /** One-click answers for step 2: label + signed feedback URL. */
  reasonLinks: Array<{ label: string; url: string }>;
  unsubscribeUrl?: string;
}

export function trialWinbackSubject(
  step: TrialWinbackEmailProps["step"],
  practiceName: string,
): string {
  switch (step) {
    case 1:
      return `${practiceName} is saved`;
    case 2:
      return `What didn't work for ${practiceName}?`;
    case 3:
      return `Last note about ${practiceName}`;
  }
}

const PREVIEW: Record<TrialWinbackEmailProps["step"], string> = {
  1: "Nothing was deleted. Add a card and you're back where you left off.",
  2: "One click tells us what to fix.",
  3: "Your workspace is still here if you change your mind.",
};

/** A personal note to a clinic whose trial ended without billing. */
export function TrialWinbackEmail({
  brand,
  step,
  practiceName,
  greetingName,
  senderName,
  usageSummary,
  reactivateUrl,
  reasonLinks,
  unsubscribeUrl,
}: TrialWinbackEmailProps) {
  return (
    <PersonalNote
      brand={brand}
      preview={PREVIEW[step]}
      greetingName={greetingName}
      senderName={senderName}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`You're receiving this because you tried ${practiceName} on OpenVPM.`}
    >
      {step === 1 ? (
        <>
          <P>
            Your OpenVPM trial for {practiceName} ended. Nothing was deleted:
            {usageSummary
              ? ` your ${usageSummary} are all still there,`
              : " everything you set up is still there,"}{" "}
            just read-only for now.
          </P>
          <P>
            <A href={reactivateUrl}>Turn {practiceName} back on</A> and
            you&apos;re back exactly where you left off.
          </P>
          <P>
            Need a few more days to decide? Reply and I&apos;ll extend your
            trial.
          </P>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <P>
            I&apos;d really like to know what didn&apos;t work for{" "}
            {practiceName}. One click is enough:
          </P>
          {reasonLinks.map((reason) => (
            <P key={reason.url} style={{ margin: "0 0 8px" }}>
              → <A href={reason.url}>{reason.label}</A>
            </P>
          ))}
          <P style={{ marginTop: "16px" }}>
            Your answer comes straight to me, and it shapes what we build next.
            Or just hit reply.
          </P>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <P>
            This is my last note about it. {practiceName} is still saved if you
            want to <A href={reactivateUrl}>pick up where you left off</A>. If
            now isn&apos;t the right time, there&apos;s nothing you need to do.
          </P>
          <P>Thanks for giving OpenVPM a try.</P>
        </>
      ) : null}
    </PersonalNote>
  );
}
