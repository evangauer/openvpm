import * as React from "react";
import { Section, Text } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Paragraph, Label } from "../components/Typography";
import { theme } from "../theme";
import type { Brand } from "../brand";

export interface SubscriptionConfirmedEmailProps {
  brand: Brand;
  practiceName: string;
  monthlyPrice: string; // e.g. "$99"
}

const INCLUDED = [
  "Unlimited staff — no per-seat charge.",
  "AI assistant and SMS allowances included each month.",
  "Daily backups, and your data is always yours to export.",
];

export function SubscriptionConfirmedEmail({
  brand,
  practiceName,
  monthlyPrice,
}: SubscriptionConfirmedEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview={`${practiceName} is on OpenVPM Cloud`}
    >
      <Heading>You&apos;re on OpenVPM Cloud 🎉</Heading>
      <Paragraph>
        Thanks for subscribing, {practiceName}. Your workspace is now fully
        active at {monthlyPrice}/location per month — everything you set up
        during the trial carries straight over.
      </Paragraph>

      <InfoCard tone="brand">
        <Label>What&apos;s included</Label>
        {INCLUDED.map((s, i) => (
          <Text
            key={i}
            style={{
              fontFamily: theme.fontBody,
              fontSize: "14px",
              lineHeight: "1.6",
              color: theme.text,
              margin: i === 0 ? "6px 0 0" : "10px 0 0",
            }}
          >
            <span style={{ color: theme.brand, fontWeight: 700 }}>✓</span> {s}
          </Text>
        ))}
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={brand.appUrl}>Go to your dashboard</Button>
      </Section>

      <Paragraph muted>
        A receipt for your first payment is on its way separately. Questions
        about your plan? Just reply to this email.
      </Paragraph>
    </EmailLayout>
  );
}
