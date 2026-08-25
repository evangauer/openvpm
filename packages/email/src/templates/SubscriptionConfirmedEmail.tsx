import * as React from "react";
import { Section } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Paragraph, Label } from "../components/Typography";
import type { Brand } from "../brand";

export interface SubscriptionConfirmedEmailProps {
  brand: Brand;
  practiceName: string;
}

export function SubscriptionConfirmedEmail({
  brand,
  practiceName,
}: SubscriptionConfirmedEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview={`${practiceName} is on OpenVPM Cloud`}
    >
      <Heading>You&apos;re on OpenVPM Cloud</Heading>
      <Paragraph>
        Thanks for subscribing, {practiceName}. Your Cloud subscription is
        active, and everything you set up before subscribing is still here.
      </Paragraph>

      <InfoCard tone="brand">
        <Label>Your workspace</Label>
        <Paragraph>
          Your team can keep working in OpenVPM with your current plan. Receipts
          for successful charges are sent separately.
        </Paragraph>
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={brand.appUrl}>Go to your dashboard</Button>
      </Section>

      <Paragraph muted>
        Questions about your plan? Reply to this email and we&apos;ll help.
      </Paragraph>
    </EmailLayout>
  );
}
