"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export function NewsletterConfirmation() {
  const [token, setToken] = useState<string | null>(null);
  const activeToken = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "confirmed">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    function readLink() {
      // A second email link may open as a same-page fragment navigation.
      // Do not erase an already loaded token when Strict Mode repeats the effect.
      if (window.location.hash) {
        const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
        activeToken.current = value;
        setToken(value);
        setState("idle"); setError(null);
        window.history.replaceState(null, "", window.location.pathname);
      }
      setReady(true);
    }
    readLink();
    window.addEventListener("hashchange", readLink);
    return () => window.removeEventListener("hashchange", readLink);
  }, []);
  async function confirm() {
    if (!token || state === "sending") return;
    setState("sending"); setError(null);
    try {
      const response = await fetch("/api/growth/newsletter/confirm", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
      });
      const result = await response.json();
      if (activeToken.current !== token) return;
      if (!response.ok) throw new Error(result.error || "Please try again.");
      setState("confirmed"); setToken(null); activeToken.current = null;
    } catch (e) {
      if (activeToken.current !== token) return;
      setError(e instanceof Error ? e.message : "We couldn't confirm your email. Please try again.");
      setState("idle");
    }
  }
  return <main id="main-content" className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
    <section className="w-full max-w-md space-y-5 rounded-2xl border bg-background p-7 shadow-sm">
      <p className="text-sm font-semibold text-primary">OpenVPM</p>
      <h1 className="text-2xl font-semibold tracking-tight">{state === "confirmed" ? "You're on the list." : "Want to hear from OpenVPM?"}</h1>
      {state === "confirmed" ? <>
        <p role="status" className="text-muted-foreground">Your subscription is confirmed. Existing email preferences still apply, and you can unsubscribe from any email.</p>
        <a className="inline-flex rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground" href="https://demo.openvpm.com/login">Explore the demo</a>
        <p><Link className="text-sm underline underline-offset-4" href="/clinic-fit">Check your clinic's fit</Link></p>
      </> : <>
        <p className="text-muted-foreground">Confirm for three short getting-started notes, then occasional product updates. Unsubscribe anytime.</p>
        {!ready ? <p role="status">Loading your link…</p> : !token ? <p role="alert">Open the confirmation link from your email. If it has expired, request a new one from the <a className="underline" href="https://openvpm.com/updates">Updates page</a>.</p> :
          <button type="button" onClick={confirm} disabled={state === "sending"} className="w-full rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground disabled:opacity-50">{state === "sending" ? "Confirming…" : "Confirm subscription"}</button>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <p className="text-sm text-muted-foreground">Didn't request these updates? You can close this page.</p>
      </>}
    </section>
  </main>;
}
