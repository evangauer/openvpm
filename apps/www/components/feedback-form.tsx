"use client";

import { useState } from "react";
import { Send, CheckCircle2, Loader2 } from "lucide-react";

type Step = "idle" | "submitting" | "success" | "error";

export function FeedbackForm() {
  const [step, setStep] = useState<Step>("idle");
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim().length < 3) return;

    setStep("submitting");
    setErrorMsg("");

    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          name: name.trim() || undefined,
          email: email.trim() || undefined,
        }),
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
      <div className="flex items-center justify-center gap-3 rounded-xl border border-teal-100 bg-teal-50/50 py-6">
        <CheckCircle2 className="w-5 h-5 text-teal-600 shrink-0" />
        <span className="text-teal-700 font-medium">
          Thank you — every note helps us make this better.
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <textarea
        required
        rows={5}
        placeholder="What's working, what's not, what you'd love to see…"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        disabled={step === "submitting"}
        className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-60 resize-none"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input
          type="text"
          placeholder="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={step === "submitting"}
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-60"
        />
        <input
          type="email"
          placeholder="Email (optional, for a reply)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={step === "submitting"}
          className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-60"
        />
      </div>
      <button
        type="submit"
        disabled={step === "submitting" || message.trim().length < 3}
        className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-teal-600 px-6 py-3 text-sm font-semibold text-white hover:bg-teal-700 transition-colors disabled:opacity-60"
      >
        {step === "submitting" ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Sending…
          </>
        ) : (
          <>
            Send feedback
            <Send className="w-4 h-4" />
          </>
        )}
      </button>
      {step === "error" && (
        <p className="text-sm text-red-600 text-center">{errorMsg}</p>
      )}
      <p className="text-xs text-gray-400 text-center pt-1">
        No account needed. Email is optional and only used to follow up.
      </p>
    </form>
  );
}
