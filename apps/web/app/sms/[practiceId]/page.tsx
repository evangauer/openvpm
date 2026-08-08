import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicMessagingProgram } from "@/lib/messaging/public-program";

export default async function SmsProgramPage({
  params,
}: {
  params: Promise<{ practiceId: string }>;
}) {
  const { practiceId } = await params;
  const program = await getPublicMessagingProgram(practiceId);
  if (!program) notFound();
  const root = "/sms/" + encodeURIComponent(program.practiceId);

  return (
    <>
      <p className="font-medium text-primary">Clinic text messaging</p>
      <h1>{program.displayName}</h1>
      <p>
        {program.displayName} may use OpenVPM to send requested veterinary
        service messages. These may include appointment reminders, vaccination
        and care updates, and replies to client questions.
      </p>

      <h2>Your choice</h2>
      <p>
        Text messaging is optional. The clinic records consent before sending
        messages. Message frequency varies, and message and data rates may
        apply. Consent is not a condition of purchasing veterinary services.
      </p>

      <h2>Manage messages</h2>
      <ul>
        <li>Reply STOP at any time to stop text messages.</li>
        <li>Reply HELP for help with the messaging program.</li>
        <li>
          You may opt back in later by replying START or giving the clinic new
          permission.
        </li>
      </ul>

      <h2>Program details</h2>
      <ul>
        <li>
          <Link href={root + "/opt-in"}>How consent is collected</Link>
        </li>
        <li>
          <Link href={root + "/privacy"}>SMS privacy policy</Link>
        </li>
        <li>
          <Link href={root + "/terms"}>SMS terms and conditions</Link>
        </li>
      </ul>

      <h2>Contact the clinic</h2>
      <p>
        {program.businessPhone ? (
          <>Call {program.businessPhone} for help.</>
        ) : program.website ? (
          <>
            Visit the clinic&apos;s <a href={program.website}>website</a> for
            contact information.
          </>
        ) : (
          <>Contact the clinic directly for help.</>
        )}
      </p>

      <p>Last updated: August 8, 2026</p>
    </>
  );
}
