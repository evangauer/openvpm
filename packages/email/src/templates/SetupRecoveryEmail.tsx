import * as React from "react";
import { Section } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Label, Paragraph } from "../components/Typography";
import type { Brand } from "../brand";

export interface SetupRecoveryEmailProps {
  brand: Brand;
  practiceName: string;
  stepTitle: string;
  nextAction: string;
  resumeUrl: string;
  attemptNumber: 1 | 2;
  unsubscribeUrl?: string;
}

export function SetupRecoveryEmail({
  brand,
  practiceName,
  stepTitle,
  nextAction,
  resumeUrl,
  attemptNumber,
  unsubscribeUrl,
}: SetupRecoveryEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview={`Resume ${practiceName} at ${stepTitle}`}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason="You're receiving this because you started an OpenVPM trial."
    >
      <Heading>
        {attemptNumber === 1
          ? "Your clinic workspace is ready"
          : `Can we help with ${stepTitle}?`}
      </Heading>
      <Paragraph>
        {practiceName} is saved exactly where you left it. OpenVPM will take you
        straight back to the next setup step—no call or credit card required.
      </Paragraph>

      <InfoCard tone="brand">
        <Label>Next step: {stepTitle}</Label>
        <Paragraph>{nextAction}</Paragraph>
      </InfoCard>

      <Section style={{ margin: "28px 0 8px" }}>
        <Button href={resumeUrl}>Resume clinic setup</Button>
      </Section>

      <Paragraph muted>
        If you would rather have help, reply to this email. For an existing PIMS
        export, we will arrange a private transfer review—please do not email
        patient files or use a public sharing link.
      </Paragraph>
    </EmailLayout>
  );
}
