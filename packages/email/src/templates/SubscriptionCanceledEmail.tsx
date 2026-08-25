import * as React from "react";
import { Section } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Paragraph, Label } from "../components/Typography";
import type { Brand } from "../brand";

export interface SubscriptionCanceledEmailProps {
  brand: Brand;
  practiceName: string;
  reactivateUrl: string;
}

export function SubscriptionCanceledEmail({
  brand,
  practiceName,
  reactivateUrl,
}: SubscriptionCanceledEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview="Your OpenVPM Cloud subscription was canceled"
    >
      <Heading>Your subscription was canceled</Heading>
      <Paragraph>
        The OpenVPM Cloud subscription for {practiceName} is no longer active.
      </Paragraph>

      <InfoCard tone="brand">
        <Label>Cancellation does not delete data</Label>
        <Paragraph>
          Canceling your subscription does not by itself delete your practice
          data. You can review your billing settings or reactivate from
          OpenVPM.
        </Paragraph>
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={reactivateUrl}>Review billing</Button>
      </Section>

      <Paragraph muted>
        If this was unexpected, reply to this email and we&apos;ll help.
      </Paragraph>
    </EmailLayout>
  );
}
