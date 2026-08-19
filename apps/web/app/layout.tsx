import type { Metadata } from "next";
import { Inter, DM_Sans } from "next/font/google";
import { headers } from "next/headers";
import { Providers } from "@/lib/providers";
import "@/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
});

export const metadata: Metadata = {
  title: "OpenVPM: Open-Source Veterinary Practice Management",
  description:
    "The first modern, open-source, API-first practice management system built for the veterinary community. Beautiful, fast, and free.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // A per-request CSP nonce cannot be attached to a statically generated
  // document. Reading the request headers opts the root layout into dynamic
  // rendering so Next.js can apply the nonce forwarded by middleware to its
  // bootstrap and page scripts. Without this, the strict CSP correctly blocks
  // hydration and leaves otherwise visible clinic forms unusable.
  const requestHeaders = await headers();
  const nonce = requestHeaders.get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${dmSans.variable} font-sans antialiased`}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          Skip to main content
        </a>
        <Providers nonce={nonce}>{children}</Providers>
      </body>
    </html>
  );
}
