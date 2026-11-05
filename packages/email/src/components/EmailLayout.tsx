import * as React from "react";
import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Row,
  Column,
  Text,
  Img,
  Preview,
} from "@react-email/components";
import { theme } from "../theme";
import type { Brand } from "../brand";
import { Footer } from "./Footer";

/**
 * The single branded shell every OpenVPM email uses: soft slate page, a brand
 * wordmark header, a clean white rounded card for the body, and the footer.
 * Visually matched to openvpm.com (teal-600, DM Sans heading, Inter body).
 */
export function EmailLayout({
  brand,
  preview,
  unsubscribeUrl,
  recipientReason,
  children,
}: {
  brand: Brand;
  preview: string;
  unsubscribeUrl?: string;
  recipientReason?: string;
  children: React.ReactNode;
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: theme.page,
          margin: 0,
          padding: 0,
          fontFamily: theme.fontBody,
          color: theme.text,
        }}
      >
        <Container
          style={{
            maxWidth: "600px",
            width: "100%",
            margin: "0 auto",
            padding: "32px 16px",
          }}
        >
          {/* Brand header */}
          <Section style={{ padding: "0 8px 20px" }}>
            {brand.logoUrl ? (
              <Img
                src={brand.logoUrl}
                alt={brand.name}
                height="32"
                style={{ height: "32px", width: "auto" }}
              />
            ) : (
              <Row>
                <Column style={{ width: "40px", verticalAlign: "middle" }}>
                  {/* The brand mark as a hosted PNG (most clients drop SVG). The
                      teal fill shows through when a client blocks images. */}
                  <Img
                    src={`${brand.appUrl.replace(/\/$/, "")}/email-mark.png`}
                    alt=""
                    width="32"
                    height="32"
                    style={{
                      display: "block",
                      width: "32px",
                      height: "32px",
                      borderRadius: "8px",
                      backgroundColor: theme.brand,
                    }}
                  />
                </Column>
                <Column style={{ verticalAlign: "middle" }}>
                  <Text
                    style={{
                      fontFamily: theme.fontHeading,
                      fontWeight: 700,
                      fontSize: "20px",
                      letterSpacing: "-0.4px",
                      color: theme.text,
                      margin: 0,
                    }}
                  >
                    OpenVPM
                  </Text>
                </Column>
              </Row>
            )}
          </Section>

          {/* Body card */}
          <Section
            style={{
              backgroundColor: theme.card,
              borderRadius: `${theme.radiusLg}px`,
              border: `1px solid ${theme.border}`,
              padding: "40px",
            }}
          >
            {children}
          </Section>

          {/* Footer */}
          <Footer
            brand={brand}
            unsubscribeUrl={unsubscribeUrl}
            recipientReason={recipientReason}
          />
        </Container>
      </Body>
    </Html>
  );
}
