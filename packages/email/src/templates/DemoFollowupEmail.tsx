import * as React from "react";
import type { Brand } from "../brand";
import { A, P, PersonalNote } from "../components/PersonalNote";

export interface DemoFollowupEmailProps {
  brand: Brand;
  step: 1 | 2 | 3 | 4;
  senderName: string | null;
  /** The first product tool the visitor opened in the demo, if any. */
  tool: { name: string; pitch: string } | null;
  trialDays: number;
  signupUrl: string;
  bookingUrl: string | null;
  unsubscribeUrl?: string;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function demoFollowupSubject(
  step: DemoFollowupEmailProps["step"],
  tool: DemoFollowupEmailProps["tool"],
): string {
  switch (step) {
    case 1:
      return "What did you think of the OpenVPM demo?";
    case 2:
      return tool
        ? `${capitalize(tool.name)}, with your own clinic`
        : "Your clinic in OpenVPM, set up in minutes";
    case 3:
      return "Want it set up with your services and prices?";
    case 4:
      return "What clinics ask before switching";
  }
}

const PREVIEW: Record<DemoFollowupEmailProps["step"], string> = {
  1: "What stood out, and what was missing for your clinic?",
  2: "The demo is sample data. Yours would be your clinic.",
  3: "15 minutes, your services, one real visit.",
  4: "Running alongside your current system, data ownership, and cost.",
};

/**
 * Follow-up for someone who tried the hosted demo. Step 1 is the single
 * "what did you think?" email every demo visitor was told to expect.
 */
export function DemoFollowupEmail({
  brand,
  step,
  senderName,
  tool,
  trialDays,
  signupUrl,
  bookingUrl,
  unsubscribeUrl,
}: DemoFollowupEmailProps) {
  return (
    <PersonalNote
      brand={brand}
      preview={PREVIEW[step]}
      greetingName={null}
      senderName={senderName}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason="You're receiving this because you tried the OpenVPM demo."
    >
      {step === 1 ? (
        <>
          <P>
            Thanks for trying the OpenVPM demo
            {tool ? ` and taking a look at ${tool.name}` : ""}. I&apos;d love
            to know what you thought: what stood out, and what was missing for
            your clinic? Just hit reply. I read every one.
          </P>
          <P>
            If you&apos;d like to see it running with your own clinic, you can{" "}
            <A href={signupUrl}>start a {trialDays}-day free trial</A>.
          </P>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <P>
            {tool
              ? `You spent time in ${tool.name} in the demo. ${tool.pitch}`
              : "The demo runs on a shared sample clinic."}
          </P>
          <P>
            In your own workspace it works with your clinic&apos;s services,
            prices, and team. The basics take a few minutes, and your current
            system stays in place while you try it.
          </P>
          <P>
            <A href={signupUrl}>Set up your clinic</A> ({trialDays}-day free
            trial)
          </P>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <P>
            If you&apos;d rather not set it up alone, I&apos;ll walk through it
            with you in 15 minutes: your services and prices, one real visit,
            and how OpenVPM runs alongside your current system while you try
            it.
          </P>
          <P>
            {bookingUrl ? (
              <A href={bookingUrl}>Pick a time that works</A>
            ) : (
              "Reply with a couple of times that work and I'll send an invite."
            )}
          </P>
          <P>
            Or <A href={signupUrl}>start on your own</A> whenever you&apos;re
            ready.
          </P>
        </>
      ) : null}

      {step === 4 ? (
        <>
          <P>Three questions clinics ask before trying OpenVPM:</P>
          <P>
            <strong>Can we run it alongside our current system?</strong> Yes.
            Most clinics start with one real visit while their current PIMS
            stays the source of truth.
          </P>
          <P>
            <strong>Who owns our data?</strong> You do. OpenVPM is open source,
            you can export everything, and you can even run it yourself.
          </P>
          <P>
            <strong>What does it cost to try?</strong> Nothing for {trialDays}{" "}
            days, then a monthly subscription per clinic location. You can
            cancel any time from Settings.
          </P>
          <P>
            Anything else on your mind? Reply and ask, or{" "}
            {bookingUrl ? (
              <A href={bookingUrl}>grab 15 minutes with me</A>
            ) : (
              <A href={signupUrl}>start your trial</A>
            )}
            . This is my last note unless you write back.
          </P>
        </>
      ) : null}
    </PersonalNote>
  );
}
