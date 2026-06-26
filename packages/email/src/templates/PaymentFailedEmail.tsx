import * as React from "react";
import { Section } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Paragraph, Label, Stat } from "../components/Typography";
import type { Brand } from "../brand";

export interface PaymentFailedEmailProps {
  brand: Brand;
  practiceName: string;
  amount: string; // e.g. "$99.00"
  nextRetryDate?: string; // e.g. "July 3, 2026"
  billingUrl: string;
}

export function PaymentFailedEmail({
  brand,
  practiceName,
  amount,
  nextRetryDate,
  billingUrl,
}: PaymentFailedEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview="Your OpenVPM payment didn't go through — update your billing"
    >
      <Heading>Your payment didn&apos;t go through</Heading>
      <Paragraph>
        Hi {practiceName}, we couldn&apos;t process your latest OpenVPM payment
        of <strong>{amount}</strong>. This usually means a card expired or was
        replaced — it&apos;s a quick fix.
      </Paragraph>

      <InfoCard tone="danger">
        <Label>What happens next</Label>
        <Paragraph>
          {nextRetryDate
            ? `We'll automatically try again on ${nextRetryDate}. Update your card before then to avoid any interruption.`
            : "Update your card to keep your workspace active and avoid any interruption."}
        </Paragraph>
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={billingUrl}>Update billing</Button>
      </Section>

      <Paragraph muted>
        Your data is safe. If a payment ultimately doesn&apos;t clear, your
        workspace becomes read-only — nothing is deleted, and reactivating takes
        one click. Need a hand? Just reply to this email.
      </Paragraph>
    </EmailLayout>
  );
}
