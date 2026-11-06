import * as React from "react";
import type { Brand } from "../brand";
import { A, P, PersonalNote } from "../components/PersonalNote";

export interface NewsletterEmailProps {
  brand: Brand;
  step: 0 | 1 | 2 | 3;
  interest: "general" | "offline" | "labs" | "migration";
  senderName: string | null;
  actionUrl: string;
  unsubscribeUrl: string;
}

export function newsletterSubject(step: NewsletterEmailProps["step"]): string {
  return ["Confirm your OpenVPM updates", "Start with one patient", "Would OpenVPM fit your clinic?", "What would you need before switching?"][step];
}

const INTEREST_COPY = {
  general: "Think about the one part of your day you'd most like to make easier. Start there.",
  offline: "If internet outages are a concern, tell us what you need to do without a connection. Offline charts are not generally available in the hosted app yet.",
  labs: "You can record and review lab results in OpenVPM today. Direct lab-provider integrations are not available yet. Reply with your lab provider if that is a requirement for your clinic.",
  migration: "Moving records is often the biggest question. Tell us which system you use and what you need to bring over. Please don't send patient records by email.",
};

export function NewsletterEmail({ brand, step, interest, senderName, actionUrl, unsubscribeUrl }: NewsletterEmailProps) {
  return <PersonalNote brand={brand} preview={newsletterSubject(step)} greetingName={null}
    senderName={senderName} unsubscribeUrl={unsubscribeUrl}
    recipientReason={step === 0 ? "You requested OpenVPM email updates." : "You confirmed that you'd like OpenVPM email updates."}>
    {step === 0 ? <>
      <P>Want to hear from OpenVPM? Confirm below for three short getting-started notes, followed by occasional product updates. You can unsubscribe anytime.</P>
      <P><A href={actionUrl}>Confirm my email</A></P>
      <P>This link expires in 48 hours. If you didn't request these updates, you can ignore this email.</P>
    </> : step === 1 ? <>
      <P>Thanks for joining. The easiest way to get a feel for OpenVPM is to try one patient visit in the sample clinic.</P>
      <P><A href={actionUrl}>Explore the demo</A>. Open a patient, look through their chart, and try a draft note. Use sample information only.</P>
      <P>What do you want to make easier at your clinic? Just reply.</P>
    </> : step === 2 ? <>
      <P>{INTEREST_COPY[interest]}</P>
      <P><A href={actionUrl}>Check your clinic's fit</A> to see what is available today and what may be a blocker.</P>
      <P>If something is unclear, reply with your question.</P>
    </> : <>
      <P>What would you need to see before considering a switch? It might be a workflow, a connection to another tool, or help moving your records.</P>
      <P>Reply with the one thing that matters most. If you're ready to explore further, <A href={actionUrl}>build a preview of your clinic</A>.</P>
      <P>This is the last getting-started note. You'll still receive occasional product updates unless you unsubscribe.</P>
    </>}
  </PersonalNote>;
}
