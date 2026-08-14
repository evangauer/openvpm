import * as React from "react";
import { Section } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Label, Paragraph, Stat } from "../components/Typography";
import type { Brand } from "../brand";

export interface FirstClinicWinEmailProps {
  brand: Brand;
  practiceName: string;
  trialEndDate: string;
  billingUrl: string;
  unsubscribeUrl?: string;
}

/** A PHI-free celebration sent only after the first completed real visit. */
export function FirstClinicWinEmail({
  brand,
  practiceName,
  trialEndDate,
  billingUrl,
  unsubscribeUrl,
}: FirstClinicWinEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview="Your team completed its first real visit in OpenVPM."
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`This is the verified OpenVPM administrator address saved for ${practiceName}.`}
    >
      <Heading>You ran your first real visit.</Heading>
      <Paragraph>
        Your team just took OpenVPM through a real clinic workflow—not a demo or
        a setup checklist. That&apos;s a meaningful first win.
      </Paragraph>

      <InfoCard tone="success">
        <Label>Your supported trial</Label>
        <Stat>Runs through {trialEndDate}</Stat>
        <Paragraph muted>
          Keep validating the workflow with your team. A card is not required
          during this supported trial.
        </Paragraph>
      </InfoCard>

      <Paragraph>
        When the clinic is ready, add billing once and the workspace can keep
        moving without an interruption at the end of the trial.
      </Paragraph>

      <Section style={{ margin: "8px 0" }}>
        <Button href={billingUrl}>Review billing</Button>
      </Section>

      <Paragraph muted>
        Questions or something that did not fit the way your clinic works? Reply
        and tell us. We&apos;re building this with clinics like yours.
      </Paragraph>
    </EmailLayout>
  );
}
