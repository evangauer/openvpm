import * as React from "react";
import { Section, Row, Column } from "@react-email/components";
import { EmailLayout } from "../components/EmailLayout";
import { Button } from "../components/Button";
import { InfoCard } from "../components/InfoCard";
import { Heading, Paragraph, Label, Stat } from "../components/Typography";
import type { Brand } from "../brand";

export interface PaymentReceiptEmailProps {
  brand: Brand;
  practiceName: string;
  amount: string; // e.g. "$99.00"
  periodLabel: string; // e.g. "Jun 10 – Jul 10, 2026"
  invoiceUrl?: string;
}

export function PaymentReceiptEmail({
  brand,
  practiceName,
  amount,
  periodLabel,
  invoiceUrl,
}: PaymentReceiptEmailProps) {
  return (
    <EmailLayout
      brand={brand}
      preview={`Your OpenVPM receipt — ${amount}`}
    >
      <Heading>Payment received</Heading>
      <Paragraph>
        Thanks, {practiceName}. We&apos;ve received your payment — here are the
        details for your records.
      </Paragraph>

      <InfoCard tone="success">
        <Row>
          <Column>
            <Label>Amount paid</Label>
            <Stat>{amount}</Stat>
          </Column>
          <Column style={{ textAlign: "right", verticalAlign: "top" }}>
            <Label>Billing period</Label>
            <Paragraph>{periodLabel}</Paragraph>
          </Column>
        </Row>
      </InfoCard>

      {invoiceUrl ? (
        <Section style={{ margin: "8px 0" }}>
          <Button href={invoiceUrl}>View invoice</Button>
        </Section>
      ) : null}

      <Paragraph muted>
        You can review every invoice and update your payment method anytime in
        billing settings. Questions? Just reply to this email.
      </Paragraph>
    </EmailLayout>
  );
}
