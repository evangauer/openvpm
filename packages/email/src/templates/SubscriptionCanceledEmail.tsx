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
  accessUntil?: string; // e.g. "August 10, 2026"
  reactivateUrl: string;
}

export function SubscriptionCanceledEmail({
  brand,
  practiceName,
  accessUntil,
  reactivateUrl,
}: SubscriptionCanceledEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview="Your OpenVPM subscription was canceled"
    >
      <Heading>Your subscription was canceled</Heading>
      <Paragraph>
        We&apos;ve canceled the OpenVPM Cloud subscription for {practiceName}.
        {accessUntil
          ? ` You'll keep full access until ${accessUntil}, then your workspace becomes read-only.`
          : " Your workspace is now read-only."}
      </Paragraph>

      <InfoCard tone="brand">
        <Label>Your data is safe</Label>
        <Paragraph>
          Nothing is deleted. You can export everything anytime, and reactivating
          restores full access immediately — right where you left off.
        </Paragraph>
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={reactivateUrl}>Reactivate</Button>
      </Section>

      <Paragraph muted>
        If this was a mistake or there&apos;s anything we could have done better,
        just reply — we read every message.
      </Paragraph>
    </EmailLayout>
  );
}
