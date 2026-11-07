import * as React from "react";
import type { Brand } from "../brand";
import { A, P, PersonalNote } from "../components/PersonalNote";

export interface TeamInviteEmailProps {
  brand: Brand;
  practiceName: string;
  greetingName: string | null;
  senderName: string | null;
  /** Real (non-sample) appointments booked so far, for a specific opener. */
  appointments: number;
  inviteUrl: string;
  unsubscribeUrl?: string;
}

export function teamInviteSubject(practiceName: string): string {
  return `Bring your team into ${practiceName}`;
}

/**
 * One nudge for a clinic that is using OpenVPM alone a few days into its
 * trial. Shared screens are where the product earns its keep.
 */
export function TeamInviteEmail({
  brand,
  practiceName,
  greetingName,
  senderName,
  appointments,
  inviteUrl,
  unsubscribeUrl,
}: TeamInviteEmailProps) {
  return (
    <PersonalNote
      brand={brand}
      preview="Staff accounts are free, and OpenVPM works best when everyone is in it."
      greetingName={greetingName}
      senderName={senderName}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`You're receiving this because you run ${practiceName} on OpenVPM.`}
    >
      <P>
        {appointments > 0
          ? `You've booked ${appointments} appointment${appointments === 1 ? "" : "s"} in ${practiceName} so far, all from your own login.`
          : `You've been setting up ${practiceName} on your own so far.`}{" "}
        OpenVPM gets a lot more useful once the front desk and your techs are
        in it too: everyone sees the same schedule, who&apos;s checked in, and
        what&apos;s due next.
      </P>
      <P>
        Staff accounts are free and unlimited.{" "}
        <A href={inviteUrl}>Invite your team</A> with a name and an email, and
        each person gets their own sign-in and role.
      </P>
      <P>If you&apos;d like a hand rolling it out, just reply.</P>
    </PersonalNote>
  );
}
