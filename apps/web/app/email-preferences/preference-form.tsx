"use client";

import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type State = "ready" | "saving" | "saved" | "error";

export function EmailPreferenceForm({ token }: { token: string }) {
  const [state, setState] = useState<State>(token ? "ready" : "error");
  const [error, setError] = useState(
    token ? "" : "This email preference link is invalid or incomplete.",
  );

  async function unsubscribe() {
    setState("saving");
    setError("");
    try {
      const response = await fetch(
        `/api/email-preferences/unsubscribe?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "We could not save that preference.");
      }
      setState("saved");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not save that preference. Try again.",
      );
      setState("error");
    }
  }

  if (state === "saved") {
    return (
      <div
        className="mt-6 flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900"
        role="status"
      >
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="text-sm font-medium">Preference saved</p>
          <p className="mt-1 text-xs leading-5">
            Optional OpenVPM emails are now off. No sign-in or sales call was
            required.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-3">
      <Button
        type="button"
        onClick={unsubscribe}
        disabled={!token || state === "saving"}
        className="w-full"
      >
        {state === "saving" ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : null}
        Turn off optional emails
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : (
        <p className="text-center text-xs text-muted-foreground">
          Immediate, no sign-in required.
        </p>
      )}
    </div>
  );
}
