import * as React from "react";
import type { Brand } from "../brand";
import { A, P, PersonalNote } from "../components/PersonalNote";

export type AdoptionTip = {
  title: string;
  body: string;
  linkLabel: string;
  url: string;
};

export interface AdoptionEmailProps {
  brand: Brand;
  practiceName: string;
  greetingName: string | null;
  senderName: string | null;
  tips: AdoptionTip[];
  unsubscribeUrl?: string;
}

export function adoptionSubject(practiceName: string, tipCount: number): string {
  return tipCount === 1
    ? `One thing worth turning on in ${practiceName}`
    : `${tipCount === 2 ? "Two" : "Three"} things worth turning on in ${practiceName}`;
}

/**
 * Two weeks after a clinic starts paying: the features it has not turned on
 * yet, each with a direct link. Sent only when there is something to suggest.
 */
export function AdoptionEmail({
  brand,
  practiceName,
  greetingName,
  senderName,
  tips,
  unsubscribeUrl,
}: AdoptionEmailProps) {
  return (
    <PersonalNote
      brand={brand}
      preview="Quick wins clinics turn on in their first month."
      greetingName={greetingName}
      senderName={senderName}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`You're receiving this because you run ${practiceName} on OpenVPM.`}
    >
      <P>
        Thanks for running {practiceName} on OpenVPM. A few things clinics
        usually turn on in their first month, which {practiceName} hasn&apos;t
        yet:
      </P>
      {tips.map((tip) => (
        <P key={tip.title}>
          <strong>{tip.title}.</strong> {tip.body}{" "}
          <A href={tip.url}>{tip.linkLabel}</A>
        </P>
      ))}
      <P>Anything else feel clunky? Reply and tell me. I read every one.</P>
    </PersonalNote>
  );
}
