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
  billingConnected?: boolean;
  /** What the clinic really did during the trial (sample data excluded). */
  usage?: TrialUsage | null;
  unsubscribeUrl?: string;
}

export interface TrialUsage {
  clients: number;
  appointments: number;
  invoices: number;
  staffCount: number;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "12 clients · 30 appointments · 3 team members", or null when empty. */
export function trialUsageLine(usage: TrialUsage): string | null {
  const parts = [
    usage.clients > 0 ? plural(usage.clients, "client") : null,
    usage.appointments > 0 ? plural(usage.appointments, "appointment") : null,
    usage.invoices > 0 ? plural(usage.invoices, "invoice") : null,
    usage.staffCount > 1 ? plural(usage.staffCount, "team member") : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function TrialEndingEmail({
  brand,
  practiceName,
  daysLeft,
  trialEndDate,
  monthlyPrice,
  billingUrl,
  billingConnected = false,
  usage = null,
  unsubscribeUrl,
}: TrialEndingEmailProps) {
  const usageLine = usage ? trialUsageLine(usage) : null;
  const whenLabel = daysLeft <= 1 ? "tomorrow" : `in ${daysLeft} days`;
  return (
    <EmailLayout
      brand={brand}
      preview={
        billingConnected
          ? `Your OpenVPM trial ends ${whenLabel}. Your billing setup is connected.`
          : `Your OpenVPM trial ends ${whenLabel}. Add billing and nothing changes.`
      }
      unsubscribeUrl={unsubscribeUrl}
      recipientReason={`This address is the OpenVPM billing contact for ${practiceName}.`}
    >
      <Heading>Your trial ends {whenLabel}</Heading>
      <Paragraph>
        Hi {practiceName}, your OpenVPM trial ends on{" "}
        <strong>{trialEndDate}</strong>.{" "}
        {billingConnected
          ? "You already completed billing setup, so there is no need to add it again."
          : "Add billing now and nothing changes."}{" "}
        Your schedule, records, and everything you&apos;ve set up stay exactly
        as they are.
      </Paragraph>

      {usageLine ? (
        <InfoCard tone="brand">
          <Label>So far in {practiceName}</Label>
          <Paragraph>{usageLine}</Paragraph>
        </InfoCard>
      ) : usage ? (
        <Paragraph muted>
          You haven&apos;t added a real client yet. Adding one client and one
          visit before the trial ends is the quickest way to see whether
          OpenVPM fits your clinic.
        </Paragraph>
      ) : null}

      <InfoCard tone="warning">
        <Label>Simple, flat pricing</Label>
        <Stat>{monthlyPrice}/location per month</Stat>
        <Paragraph muted>
          Unlimited staff, with AI and SMS allowances included. Cancel anytime.
        </Paragraph>
      </InfoCard>

      <Section style={{ margin: "8px 0" }}>
        <Button href={billingUrl}>
          {billingConnected ? "Review billing" : "Add billing"}
        </Button>
      </Section>

      <Paragraph muted>
        If your trial lapses, your workspace simply becomes read only. Nothing
        is deleted, and you can turn it back on anytime by adding a card.
      </Paragraph>
    </EmailLayout>
  );
}
