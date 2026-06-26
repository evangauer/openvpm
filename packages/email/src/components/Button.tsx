import * as React from "react";
import { Button as REButton } from "@react-email/components";
import { theme } from "../theme";

/** Primary CTA — teal-600, white text, rounded-lg (matches the site button). */
export function Button({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <REButton
      href={href}
      style={{
        backgroundColor: theme.brand,
        color: "#ffffff",
        fontFamily: theme.fontHeading,
        fontSize: "15px",
        fontWeight: 600,
        borderRadius: `${theme.radius}px`,
        padding: "13px 26px",
        textDecoration: "none",
        display: "inline-block",
      }}
    >
      {children}
    </REButton>
  );
}
