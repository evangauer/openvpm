import * as React from "react";
import type { Brand } from "../brand";
import { A, P, PersonalNote } from "../components/PersonalNote";

export interface BuildFollowupEmailProps {
  brand: Brand;
  step: 1 | 2;
  clinicName: string;
  /** The color they chose, shown as a little badge of their clinic. */
  brandColor: string;
  /** The system they're coming from, e.g. "Shepherd"; null for paper. */
  currentSystem: string | null;
  senderName: string | null;
  resumeUrl: string;
  bookingUrl: string | null;
  unsubscribeUrl?: string;
}

export function buildFollowupSubject(
  step: BuildFollowupEmailProps["step"],
  clinicName: string,
): string {
  return step === 1
    ? `${clinicName} is saved`
    : `Anything I can help with before you open ${clinicName}?`;
}

function ClinicBadge({ name, color }: { name: string; color: string }) {
  return (
    <table cellPadding={0} cellSpacing={0} role="presentation" style={{ margin: "4px 0 18px" }}>
      <tbody>
        <tr>
          <td
            style={{
              background: color,
              borderRadius: "10px",
              padding: "10px 14px",
              color: "#ffffff",
              fontWeight: 700,
              fontSize: "15px",
              fontFamily:
                "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
            }}
          >
            {name}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** Follow-up for someone who saved "Build your clinic" and left. */
export function BuildFollowupEmail({
  brand,
  step,
  clinicName,
  brandColor,
  currentSystem,
  senderName,
  resumeUrl,
  bookingUrl,
  unsubscribeUrl,
}: BuildFollowupEmailProps) {
  return (
    <PersonalNote
      brand={brand}
      preview={
        step === 1
          ? "Pick up right where you left off."
          : "Records, texting, price: ask me anything."
      }
      greetingName={null}
      senderName={senderName}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason="You're receiving this because you saved your clinic on OpenVPM."
    >
      {step === 1 ? (
        <>
          <P>
            You started building {clinicName} on OpenVPM. It&apos;s saved,
            colors and services included:
          </P>
          <ClinicBadge name={clinicName} color={brandColor} />
          <P>
            <A href={resumeUrl}>Pick up where you left off</A>. It takes a
            couple of minutes to see your clinic end to end: a client booking,
            reminders going out, a visit, and getting paid.
          </P>
          <P>If anything gave you pause, just reply. I read every one.</P>
        </>
      ) : (
        <>
          <P>
            Most clinics have a question or two before they switch:
            {currentSystem
              ? ` moving records from ${currentSystem},`
              : " getting their records in,"}{" "}
            how texting works, or what it costs. What&apos;s yours? Just reply.
          </P>
          <P>
            {bookingUrl ? (
              <>
                Or <A href={bookingUrl}>grab 15 minutes with me</A> and
                we&apos;ll set it up together.
              </>
            ) : (
              "Or reply with a couple of times, and we'll set it up together on a short call."
            )}
          </P>
          <P>
            {clinicName} is still saved: <A href={resumeUrl}>open it here</A>.
          </P>
        </>
      )}
    </PersonalNote>
  );
}
