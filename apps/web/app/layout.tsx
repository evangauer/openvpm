import type { Metadata } from "next";
import { Inter, DM_Sans } from "next/font/google";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { IntlProvider } from "@/components/i18n/intl-provider";
import { Providers } from "@/lib/providers";
import "@/i18n/global";
import "@/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata");
  return {
    title: t("title"),
    description: t("description"),
    icons: {
      icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const language = await getLocale();
  const messages = await getMessages();
  const t = await getTranslations("common");

  return (
    <html lang={language} suppressHydrationWarning>
      <body
        className={`${inter.variable} ${dmSans.variable} font-sans antialiased`}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
        >
          {t("skipToContent")}
        </a>
        <IntlProvider locale={language} messages={messages}>
          <Providers analyticsEnabled={process.env.VERCEL === "1"}>
            {children}
          </Providers>
        </IntlProvider>
      </body>
    </html>
  );
}
