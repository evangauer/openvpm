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
  variant?: "add_billing" | "billing_connected";
  unsubscribeUrl?: string;
}

export function TrialEndingEmail({
  brand,
  practiceName,
  daysLeft,
  trialEndDate,
  monthlyPrice,
  billingUrl,
  variant = "add_billing",
  unsubscribeUrl,
}: TrialEndingEmailProps) {
  const whenLabel = daysLeft <= 1 ? "tomorrow" : `in ${daysLeft} days`;
  return (
    <EmailLayout
      brand={brand}
      preview={
        variant === "billing_connected"
          ? `Your OpenVPM trial ends ${whenLabel}. Your billing setup is already connected.`
          : `Your OpenVPM trial ends ${whenLabel}. Add billing to keep write access available.`
      }
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`You’re receiving this because this is the practice email saved for ${practiceName}.`}
    >
      <Heading>Your trial ends {whenLabel}</Heading>
      <Paragraph>
        Hi {practiceName}, your OpenVPM trial ends on{" "}
        <strong>{trialEndDate}</strong>.{" "}
        {variant === "billing_connected"
          ? "You already completed billing setup through Stripe, so you do not need to add it again."
          : "Add billing before then to keep write access available without interruption."}
      </Paragraph>

      <InfoCard tone="warning">
        <Label>Simple, flat pricing</Label>
        <Stat>{monthlyPrice}/location per month</Stat>
        <Paragraph muted>
          Unlimited staff. Includes 1,000 texts and 1,000 AI actions monthly;
          additional usage is $0.03 per text and $0.05 per AI action. Plus
          applicable tax. Cancel anytime.
        </Paragraph>
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={billingUrl}>
          {variant === "billing_connected" ? "Review billing" : "Add billing"}
        </Button>
      </Section>

      <Paragraph muted>
        {variant === "billing_connected"
          ? "If your trial lapses because billing needs attention, your workspace simply becomes read only. Nothing is deleted; review billing to restore write access."
          : "If your trial lapses, your workspace simply becomes read only. Nothing is deleted, and you can turn it back on anytime by adding a card."}
      </Paragraph>
    </EmailLayout>
  );
}
