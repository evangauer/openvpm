import { notFound } from "next/navigation";
import { getPublicMessagingProgram } from "@/lib/messaging/public-program";
import { SMS_CONSENT_DISCLOSURE } from "@/lib/messaging/consent";

export default async function SmsOptInPage({
  params,
}: {
  params: Promise<{ practiceId: string }>;
}) {
  const { practiceId } = await params;
  const program = await getPublicMessagingProgram(practiceId);
  if (!program) notFound();

  return (
    <>
      <p className="font-medium text-primary">{program.displayName}</p>
      <h1>How SMS consent is collected</h1>
      <p>Last updated: August 8, 2026</p>

      <p>
        Clients may opt in during phone or in-person intake. Clinic staff read
        or show the disclosure below, ask for an explicit choice, and record the
        client&apos;s answer in OpenVPM. The consent control is optional and is
        not selected by default. No text is sent until consent is recorded.
      </p>

      <h2>Disclosure shown or read to clients</h2>
      <blockquote className="rounded-lg border border-border bg-card p-5 text-base leading-7 text-foreground shadow-sm">
        {SMS_CONSENT_DISCLOSURE.snapshot}
      </blockquote>

      <h2>Evidence retained</h2>
      <p>
        OpenVPM records the consent choice, date and time, mobile number,
        disclosure text, and consent source. Replying STOP creates a suppression
        that blocks further sends. Replying START, YES, or UNSTOP may
        re-establish consent from the client&apos;s own phone.
      </p>
    </>
  );
}
