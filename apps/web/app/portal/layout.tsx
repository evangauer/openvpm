import type { Metadata } from "next";
import { CookiePreferencesLink } from "@/components/common/cookie-consent";

export const metadata: Metadata = {
  title: "Pet Portal - OpenVPM",
  description: "View your pet's health information",
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <span className="text-white font-bold text-sm">OP</span>
            </div>
            <div>
              <span className="font-semibold text-gray-900 text-sm">OpenVPM</span>
              <span className="text-teal-600 text-sm ml-1.5 font-medium">Pet Portal</span>
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
      <footer className="border-t border-gray-100 mt-12">
        <div className="mx-auto max-w-4xl px-4 py-6 text-center text-sm text-gray-400">
          Powered by OpenVPM
          <span className="mx-2" aria-hidden="true">
            ·
          </span>
          <a
            href="/legal/privacy"
            className="underline-offset-2 hover:text-gray-600 hover:underline"
          >
            Privacy
          </a>
          <span className="mx-2" aria-hidden="true">
            ·
          </span>
          <CookiePreferencesLink className="underline-offset-2 hover:text-gray-600 hover:underline" />
        </div>
      </footer>
    </div>
  );
}
