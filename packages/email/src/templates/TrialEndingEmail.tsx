import * as React from "react";
import { Section } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Paragraph, Label, Stat } from "../components/Typography";
import type { Brand } from "../brand";

export interface TrialEndingEmailProps {
  brand: Brand;
  practiceName: string;
  daysLeft: number;
  trialEndDate: string; // e.g. "July 10, 2026"
  monthlyPrice: string; // e.g. "$79"
  billingUrl: string;
  unsubscribeUrl?: string;
}

export function TrialEndingEmail({
  brand,
  practiceName,
  daysLeft,
  trialEndDate,
  monthlyPrice,
  billingUrl,
  unsubscribeUrl,
}: TrialEndingEmailProps) {
  const whenLabel =
    daysLeft <= 1 ? "tomorrow" : `in ${daysLeft} days`;
  return (
    <EmailLayout
      brand={brand}
      preview={`Your OpenVPM trial ends ${whenLabel}. Add a card and nothing changes.`}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`This address is the OpenVPM billing contact for ${practiceName}.`}
    >
      <Heading>Your trial ends {whenLabel}</Heading>
      <Paragraph>
        Hi {practiceName}, your OpenVPM trial ends on{" "}
        <strong>{trialEndDate}</strong>. Add a card now and nothing changes.
        Your schedule, your records, and everything you&apos;ve set up stay
        exactly as they are.
      </Paragraph>

      <InfoCard tone="warning">
        <Label>Simple, flat pricing</Label>
        <Stat>{monthlyPrice}/location per month</Stat>
        <Paragraph muted>
          Unlimited staff, with AI and SMS allowances included. Cancel anytime.
        </Paragraph>
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={billingUrl}>Add billing</Button>
      </Section>

      <Paragraph muted>
        If your trial lapses, your workspace simply becomes read only. Nothing
        is deleted, and you can turn it back on anytime by adding a card.
      </Paragraph>
    </EmailLayout>
  );
}
