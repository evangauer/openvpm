import * as React from "react";
import { Section } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Paragraph, Label, Stat } from "../components/Typography";
import type { Brand } from "../brand";

export interface FirstClinicWinEmailProps {
  brand: Brand;
  practiceName: string;
  trialEndDate: string;
  monthlyPrice: string;
  billingUrl: string;
  unsubscribeUrl?: string;
}

export function FirstClinicWinEmail({
  brand,
  practiceName,
  trialEndDate,
  monthlyPrice,
  billingUrl,
  unsubscribeUrl,
}: FirstClinicWinEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview="Your team completed its first real clinic visit in OpenVPM."
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`You’re receiving this because this is the practice email saved for ${practiceName}.`}
    >
      <Heading>You completed your first clinic visit in OpenVPM</Heading>
      <Paragraph>
        Your team has taken a real visit through clinical handoff and checkout.
        Your trial remains fully featured through{" "}
        <strong>{trialEndDate}</strong>. Add billing before then to keep write
        access available without interruption.
      </Paragraph>

      <InfoCard>
        <Label>OpenVPM Cloud</Label>
        <Stat>{monthlyPrice}/location per month</Stat>
        <Paragraph muted>
          Unlimited staff. Includes 1,000 texts and 1,000 AI actions monthly;
          additional usage is $0.03 per text and $0.05 per AI action. Plus
          applicable tax. Cancel anytime.
        </Paragraph>
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={billingUrl}>Add billing</Button>
      </Section>

      <Paragraph muted>
        If the trial lapses, the workspace becomes read only. Nothing is
        deleted, and billing can restore write access later.
      </Paragraph>
    </EmailLayout>
  );
}
