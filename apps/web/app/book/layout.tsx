import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Book an appointment",
  description: "Book an appointment online",
};

export default function BookingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <main className="mx-auto max-w-2xl px-4 py-8">{children}</main>
      <footer className="mt-12 border-t border-gray-100 bg-white">
        <div className="mx-auto max-w-2xl px-4 py-6 text-center text-sm text-gray-400">
          Powered by{" "}
          <a
            href="https://openvpm.com"
            className="underline-offset-2 hover:text-gray-600 hover:underline"
          >
            OpenVPM
          </a>
          <span className="mx-2" aria-hidden="true">
            ·
          </span>
          <a
            href="/legal/privacy"
            className="underline-offset-2 hover:text-gray-600 hover:underline"
          >
            Privacy
          </a>
        </div>
      </footer>
    </div>
  );
}
