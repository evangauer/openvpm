import type { Metadata } from "next";
import { PawMark } from "@/components/brand/paw-mark";

export const metadata: Metadata = {
  title: "Record Visit - OpenVPM",
  description: "Record the visit for its notes",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Standalone shell for the no-login Scribe phone page (mirrors the photo
 * capture layout). No patient or clinic details appear anywhere in this flow.
 */
export default function ScribeCaptureLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-lg items-center gap-2 px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600">
            <PawMark className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-semibold text-gray-900">OpenVPM</span>
          <span className="text-sm font-medium text-teal-600">Record Visit</span>
        </div>
      </header>
      <main className="mx-auto max-w-lg px-4 py-6">{children}</main>
    </div>
  );
}
