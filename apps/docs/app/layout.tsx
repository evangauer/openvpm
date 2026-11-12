import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { DM_Sans, Inter } from "next/font/google";
import { SearchDialog } from "@/components/search";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { APP_URL } from "@/content/catalog";
import { searchEntries } from "@/lib/content";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans" });

const SITE_URL = "https://docs.openvpm.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "OpenVPM Help", template: "%s · OpenVPM Help" },
  description: "Step-by-step guides with real screens, for every role in the clinic.",
  applicationName: "OpenVPM Help",
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }] },
  openGraph: { siteName: "OpenVPM Help", type: "website", url: SITE_URL },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const entries = searchEntries().map((e) => ({ ...e, body: e.body.slice(0, 1500) }));
  return (
    <html lang="en">
      <body className={`${inter.variable} ${dmSans.variable} font-sans antialiased`}>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <SiteHeader appUrl={APP_URL} />
        <main id="main-content">{children}</main>
        <SiteFooter />
        <SearchDialog entries={entries} />
        <Analytics />
      </body>
    </html>
  );
}
