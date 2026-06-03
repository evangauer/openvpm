"use client";

import { useState } from "react";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

type Step = "idle" | "submitting" | "success" | "error";

export function SubscribeForm({ source }: { source?: string }) {
  const [step, setStep] = useState<Step>("idle");
  const [email, setEmail] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStep("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStep("error");
        setErrorMsg(data.error || "Something went wrong. Please try again.");
        return;
      }
      setStep("success");
    } catch {
      setStep("error");
      setErrorMsg("Something went wrong. Please try again.");
    }
  };

  if (step === "success") {
    return (
      <div className="flex items-center justify-center gap-2 py-2 text-teal-700 font-medium">
        <CheckCircle2 className="w-5 h-5 shrink-0" />
        Subscribed — talk soon.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
      <input
        type="email"
        required
        placeholder="you@clinic.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={step === "submitting"}
        className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-60"
      />
      <button
        type="submit"
        disabled={step === "submitting"}
        className="inline-flex items-center justify-center gap-2 rounded-xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white hover:bg-teal-700 transition-colors disabled:opacity-60"
      >
        {step === "submitting" ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Subscribing…
          </>
        ) : (
          <>
            Subscribe
            <ArrowRight className="w-4 h-4" />
          </>
        )}
      </button>
      {step === "error" && (
        <p className="text-sm text-red-600 sm:absolute sm:mt-14">{errorMsg}</p>
      )}
    </form>
  );
}
