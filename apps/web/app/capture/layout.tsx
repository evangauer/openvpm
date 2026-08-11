import type { Metadata } from "next";
import { PawMark } from "@/components/brand/paw-mark";

export const metadata: Metadata = {
  title: "Add Photos - OpenVPM",
  description: "Add photos to the visit record",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Standalone shell for the no-login QR capture page (mirrors the portal
 * layout). PHI-minimal on purpose: no patient or practice details appear
 * anywhere in this flow.
 */
export default function CaptureLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="mx-auto max-w-lg px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-teal-600 flex items-center justify-center">
              <PawMark className="h-4 w-4 text-white" />
            </div>
            <div>
              <span className="font-semibold text-gray-900 text-sm">
                OpenVPM
              </span>
              <span className="text-teal-600 text-sm ml-1.5 font-medium">
                Photo Capture
              </span>
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-lg px-4 py-6">{children}</main>
      <footer className="border-t border-gray-100 mt-12">
        <div className="mx-auto max-w-lg px-4 py-6 text-center text-sm text-gray-400">
          Powered by OpenVPM
        </div>
      </footer>
    </div>
  );
}
