import type { Metadata } from "next";
import Link from "next/link";
import { EmailPreferenceForm } from "./preference-form";

export const metadata: Metadata = {
  title: "Email preferences - OpenVPM",
  description: "Manage optional OpenVPM email updates.",
  robots: { index: false, follow: false },
};

export default async function EmailPreferencesPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";

  return (
    <main
      id="main-content"
      className="flex min-h-screen items-center justify-center bg-surface px-4 py-12"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <Link href="/" className="font-heading text-lg font-semibold">
          OpenVPM
        </Link>
        <div className="mt-8 space-y-3">
          <h1 className="font-heading text-2xl font-semibold">
            Email preferences
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Stop optional OpenVPM product, trial, research, and feedback emails
            with one click.
          </p>
        </div>

        <EmailPreferenceForm token={token} />

        <div className="mt-6 rounded-lg bg-muted/50 p-4 text-xs leading-5 text-muted-foreground">
          This preference does not apply to important security alerts, billing
          receipts, or service notices. It also does not affect messages your
          clinic sends to pet owners. Optional emails stay off for this address.
        </div>
      </div>
    </main>
  );
}
