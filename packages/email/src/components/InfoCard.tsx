import * as React from "react";
import { Section } from "@react-email/components";
import { theme } from "../theme";

type Tone = "brand" | "success" | "warning" | "danger";

const TONES: Record<Tone, { bg: string; border: string }> = {
  brand: { bg: theme.brandTint, border: theme.brandTintBorder },
  success: { bg: theme.successTint, border: theme.successBorder },
  warning: { bg: theme.warningTint, border: theme.warningBorder },
  danger: { bg: theme.dangerTint, border: theme.dangerBorder },
};

/** Tinted, bordered panel for highlighting an amount, date, or usage stat. */
export function InfoCard({
  tone = "brand",
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <Section
      style={{
        backgroundColor: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: "12px",
        padding: "20px 24px",
        margin: "24px 0",
      }}
    >
      {children}
    </Section>
  );
}
