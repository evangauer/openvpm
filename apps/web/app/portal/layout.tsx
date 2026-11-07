import type { Metadata } from "next";
import { PortalShell } from "@/components/portal/portal-shell";

export const metadata: Metadata = {
  title: "Pet Portal - OpenVPM",
  description: "View your pet's health information",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PortalShell>{children}</PortalShell>;
}
