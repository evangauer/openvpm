import * as React from "react";
import { Section, Text } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Paragraph, Label } from "../components/Typography";
import { theme } from "../theme";
import type { Brand } from "../brand";

export interface WelcomeEmailProps {
  brand: Brand;
  practiceName: string;
  trialDays: number;
  unsubscribeUrl?: string;
}

const STEPS = [
  "Take the 60-second tour of the schedule, records, and billing.",
  "Make it yours: add your logo, accent color, and invite your team.",
  "Ask the AI assistant something, like “which pets are overdue for vaccines?”",
];

export function WelcomeEmail({
  brand,
  practiceName,
  trialDays,
  unsubscribeUrl,
}: WelcomeEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview={`Welcome to OpenVPM — your ${trialDays}-day trial is ready`}
      unsubscribeUrl={unsubscribeUrl}
      recipientReason="You're receiving this because you created an OpenVPM account."
    >
      <Heading>Welcome to OpenVPM 🎉</Heading>
      <Paragraph>
        Hi {practiceName}, your workspace is ready. We set it up with a sample
        practice — real clients, pets, and appointments — so the app feels alive
        from the very first minute.
      </Paragraph>
      <Paragraph muted>
        Your {trialDays}-day trial is fully featured with no credit card
        required, and your data is always yours to export.
      </Paragraph>

      <Section style={{ margin: "28px 0 8px" }}>
        <Button href={brand.appUrl}>Open your dashboard</Button>
      </Section>

      <InfoCard tone="brand">
        <Label>Get started</Label>
        {STEPS.map((s, i) => (
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
            <span style={{ color: theme.brand, fontWeight: 700 }}>→</span> {s}
          </Text>
        ))}
      </InfoCard>

      <Paragraph muted>
        Questions? Just reply to this email — it reaches a real person.
      </Paragraph>
    </EmailLayout>
  );
}
