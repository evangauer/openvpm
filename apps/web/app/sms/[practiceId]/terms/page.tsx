import { notFound } from "next/navigation";
import { getPublicMessagingProgram } from "@/lib/messaging/public-program";

export default async function SmsTermsPage({
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
      <h1>SMS terms and conditions</h1>
      <p>Last updated: August 8, 2026</p>

      <h2>Program</h2>
      <p>
        By opting in, you authorize {program.displayName} to send veterinary
        service text messages to the mobile number you provide. Messages may
        include appointment reminders, vaccination and care updates,
        prescription or follow-up notices, and two-way client support. OpenVPM
        supplies the clinic&apos;s messaging technology.
      </p>

      <h2>Consent and frequency</h2>
      <p>
        Your consent is optional and is not a condition of purchasing goods or
        services. Message frequency varies based on your pets&apos; care and
        your interactions with the clinic. Message and data rates may apply.
      </p>

      <h2>Opt out and help</h2>
      <ul>
        <li>Reply STOP to cancel text messages.</li>
        <li>Reply HELP for help.</li>
        <li>
          After opting out, you may receive one confirmation message. You can
          later reply START or give the clinic new consent to resume messages.
        </li>
      </ul>

      <h2>Delivery</h2>
      <p>
        Carriers are not liable for delayed or undelivered messages. Texting is
        not appropriate for emergencies. Contact an emergency veterinary
        provider directly when urgent care is needed.
      </p>

      <h2>Privacy and contact</h2>
      <p>
        The clinic&apos;s SMS privacy policy explains how messaging information
        is handled. For program help,{" "}
        {program.businessPhone ? (
          <>call {program.businessPhone}.</>
        ) : program.website ? (
          <>
            visit the clinic&apos;s <a href={program.website}>website</a>.
          </>
        ) : (
          <>contact {program.displayName} directly.</>
        )}
      </p>
    </>
  );
}
