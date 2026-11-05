import * as React from "react";
import type { Brand } from "../brand";
import { A, P, PersonalNote } from "../components/PersonalNote";

export interface CheckoutRecoveryEmailProps {
  brand: Brand;
  step: 1 | 2 | 3 | 4;
  practiceName: string;
  /** Recipient's first name; null greets with "Hi there". */
  greetingName: string | null;
  /** Signature; null signs as the OpenVPM team. */
  senderName: string | null;
  trialDays: number;
  resumeUrl: string;
  /** One-click answers for step 2: label + signed feedback URL. */
  reasonLinks: Array<{ label: string; url: string }>;
  /** Signed feedback page with no answer preselected. */
  feedbackUrl: string;
  bookingUrl: string | null;
  unsubscribeUrl?: string;
}

export function checkoutRecoverySubject(
  step: CheckoutRecoveryEmailProps["step"],
  practiceName: string,
): string {
  switch (step) {
    case 1:
      return `Finish starting ${practiceName}'s OpenVPM trial`;
    case 2:
      return `Quick question about ${practiceName}`;
    case 3:
      return `Want a hand setting up ${practiceName}?`;
    case 4:
      return `Should we keep ${practiceName}'s workspace?`;
  }
}

const PREVIEW: Record<CheckoutRecoveryEmailProps["step"], string> = {
  1: "Your clinic is saved. One step left to start your trial.",
  2: "One click tells us what got in the way.",
  3: "15 minutes, your services, one real visit.",
  4: "Last note from me about this.",
};

/**
 * A personal note to a clinic that registered but never started its trial.
 * Replies go to a real inbox.
 */
export function CheckoutRecoveryEmail({
  brand,
  step,
  practiceName,
  greetingName,
  senderName,
  trialDays,
  resumeUrl,
  reasonLinks,
  feedbackUrl,
  bookingUrl,
  unsubscribeUrl,
}: CheckoutRecoveryEmailProps) {
  return (
    <PersonalNote
      brand={brand}
      preview={PREVIEW[step]}
      greetingName={greetingName}
      senderName={senderName}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`You're receiving this because you created ${practiceName} on OpenVPM.`}
    >
      {step === 1 ? (
        <>
          <P>
            You set up {practiceName} on OpenVPM but didn&apos;t get to the last
            step: starting the trial. Everything you entered is saved.
          </P>
          <P>
            <A href={resumeUrl}>Finish starting your trial</A>
          </P>
          <P>
            You won&apos;t be charged during the {trialDays}-day trial, and you
            can cancel from Settings any time before it ends.
          </P>
          <P>If something got in the way, just reply. I read every reply.</P>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <P>
            You created {practiceName} on OpenVPM but haven&apos;t started the
            trial yet. Would you tell me what stopped you? One click is enough:
          </P>
          {reasonLinks.map((reason) => (
            <P key={reason.url} style={{ margin: "0 0 8px" }}>
              → <A href={reason.url}>{reason.label}</A>
            </P>
          ))}
          <P style={{ marginTop: "16px" }}>
            Your answer comes straight to me, and I&apos;ll follow up
            personally. Or just hit reply.
          </P>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <P>
            A lot of clinics find it easier to set up OpenVPM with someone. If
            that would help, I&apos;ll walk through it with you in 15 minutes:
            your services and prices, one real visit, and how your current
            system stays in place while you try it.
          </P>
          <P>
            {bookingUrl ? (
              <A href={bookingUrl}>Pick a time that works</A>
            ) : (
              "Reply with a couple of times that work and I'll send an invite."
            )}
          </P>
          <P>
            Prefer to do it yourself?{" "}
            <A href={resumeUrl}>Pick up where you left off</A>.
          </P>
        </>
      ) : null}

      {step === 4 ? (
        <>
          <P>
            I haven&apos;t heard back, so this is my last note about it.{" "}
            {practiceName} is still saved if you want to{" "}
            <A href={resumeUrl}>start your trial</A>. If now isn&apos;t the
            right time, there&apos;s nothing you need to do.
          </P>
          <P>
            If OpenVPM isn&apos;t a fit, I&apos;d really value knowing why.{" "}
            <A href={feedbackUrl}>It takes one click</A>.
          </P>
        </>
      ) : null}
    </PersonalNote>
  );
}
