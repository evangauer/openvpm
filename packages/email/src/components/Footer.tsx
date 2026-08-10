import * as React from "react";
import { Section, Text, Link } from "@react-email/components";
import { theme } from "../theme";
import type { Brand } from "../brand";

/**
 * Footer with company identity + support contact. For promotional nudges
 * (trial-ending, usage warnings) pass `unsubscribeUrl` to surface a preferences
 * link; transactional mail (receipts, dunning) omits it.
 */
export function Footer({
  brand,
  unsubscribeUrl,
  recipientReason,
}: {
  brand: Brand;
  unsubscribeUrl?: string;
  recipientReason?: string;
}) {
  return (
    <Section style={{ padding: "24px 8px 0" }}>
      <Text
        style={{
          fontFamily: theme.fontBody,
          fontSize: "13px",
          lineHeight: "1.6",
          color: theme.subtle,
          margin: 0,
        }}
      >
        <strong style={{ color: theme.muted }}>{brand.companyName}</strong>
        {"  ·  "}
        <Link
          href={`mailto:${brand.supportEmail}`}
          style={{ color: theme.subtle, textDecoration: "underline" }}
        >
          {brand.supportEmail}
        </Link>
        {brand.companyAddress ? (
          <>
            <br />
            {brand.companyAddress}
          </>
        ) : null}
      </Text>
      <Text
        style={{
          fontFamily: theme.fontBody,
          fontSize: "12px",
          lineHeight: "1.6",
          color: theme.faint,
          margin: "10px 0 0",
        }}
      >
        {recipientReason ??
          "You're receiving this because your clinic uses OpenVPM."}
        {unsubscribeUrl ? (
          <>
            {"  "}
            <Link
              href={unsubscribeUrl}
              style={{ color: theme.faint, textDecoration: "underline" }}
            >
              Manage email preferences
            </Link>
            .
          </>
        ) : null}
      </Text>
    </Section>
  );
}
