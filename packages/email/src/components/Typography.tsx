import * as React from "react";
import { Heading as REHeading, Text } from "@react-email/components";
import { theme } from "../theme";

/** Email H1 — DM Sans, tight tracking, like the site headings. */
export function Heading({ children }: { children: React.ReactNode }) {
  return (
    <REHeading
      as="h1"
      style={{
        fontFamily: theme.fontHeading,
        fontSize: "24px",
        fontWeight: 700,
        letterSpacing: "-0.02em",
        lineHeight: "1.25",
        color: theme.text,
        margin: "0 0 16px",
      }}
    >
      {children}
    </REHeading>
  );
}

export function Paragraph({
  children,
  muted,
}: {
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <Text
      style={{
        fontFamily: theme.fontBody,
        fontSize: "15px",
        lineHeight: "1.65",
        color: muted ? theme.muted : theme.text,
        margin: "0 0 16px",
      }}
    >
      {children}
    </Text>
  );
}

/** Small uppercase label, e.g. inside an InfoCard. */
export function Label({ children }: { children: React.ReactNode }) {
  return (
    <Text
      style={{
        fontFamily: theme.fontBody,
        fontSize: "12px",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: theme.subtle,
        margin: "0 0 4px",
      }}
    >
      {children}
    </Text>
  );
}

/** Big emphasized value, e.g. an amount or a date. */
export function Stat({ children }: { children: React.ReactNode }) {
  return (
    <Text
      style={{
        fontFamily: theme.fontHeading,
        fontSize: "22px",
        fontWeight: 700,
        color: theme.text,
        margin: 0,
      }}
    >
      {children}
    </Text>
  );
}
