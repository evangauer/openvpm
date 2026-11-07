"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, LockKeyhole } from "lucide-react";
import { fetchWithClientTimeout } from "@/lib/client-fetch";

export default function PortalAccessPage() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function continueToPortal() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithClientTimeout("/api/portal/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await response.json()) as {
        redirectTo?: string;
        error?: string;
      };
      if (!response.ok || body.redirectTo !== "/portal") {
        throw new Error(body.error || "Unable to open the portal");
      }
      window.location.replace(body.redirectTo);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to open the portal. Please ask your clinic for a new link.",
      );
      setLoading(false);
    }
  }

  return (
    <section className="mx-auto max-w-md rounded-2xl border border-gray-200 bg-white p-7 text-center shadow-sm">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <LockKeyhole className="h-6 w-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-xl font-semibold text-gray-900">
        Open your secure pet portal
      </h1>
      <p className="mt-2 text-sm leading-6 text-gray-600">
        This private link can be used once and expires shortly. Continuing
        creates a secure session on this device and removes the link from your
        address bar.
      </p>
      <button
        type="button"
        onClick={continueToPortal}
        disabled={loading}
        className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-primary px-5 py-3 font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Opening portal…" : "Continue securely"}
      </button>
      {error ? (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-left text-sm text-red-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
    </section>
  );
}
