import * as React from "react";
import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Preview,
} from "@react-email/components";
import { theme } from "../theme";
import type { Brand } from "../brand";
import { Footer } from "./Footer";

const text: React.CSSProperties = {
  fontFamily: theme.fontBody,
  fontSize: "15px",
  lineHeight: "1.6",
  color: theme.text,
  margin: "0 0 16px",
};

const link: React.CSSProperties = {
  color: theme.brandDark,
  textDecoration: "underline",
};

export function P({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return <Text style={{ ...text, ...style }}>{children}</Text>;
}

export function A({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} style={link}>
      {children}
    </Link>
  );
}

/**
 * A plain, personal note: no header, card, or buttons, signed by a person.
 * Used for follow-up that should read like (and is) an email from someone
 * who will answer a reply. The footer keeps the legal identity and the
 * preferences link.
 */
export function PersonalNote({
  brand,
  preview,
  greetingName,
  senderName,
  recipientReason,
  unsubscribeUrl,
  children,
}: {
  brand: Brand;
  preview: string;
  greetingName: string | null;
  senderName: string | null;
  recipientReason: string;
  unsubscribeUrl?: string;
  children: React.ReactNode;
}) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: theme.card, margin: 0, padding: 0 }}>
        <Container
          style={{ maxWidth: "560px", width: "100%", padding: "24px 16px" }}
        >
          <P>Hi {greetingName ?? "there"},</P>
          {children}
          <P style={{ margin: "24px 0 0" }}>
            {senderName ? (
              <>
                {senderName}
                <br />
                OpenVPM
              </>
            ) : (
              "The OpenVPM team"
            )}
          </P>
        </Container>
        <Container style={{ maxWidth: "560px", width: "100%" }}>
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
