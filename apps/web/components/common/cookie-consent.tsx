"use client";

import { useEffect, useState } from "react";
import { Analytics } from "@vercel/analytics/next";
import { Check, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export const COOKIE_CONSENT_STORAGE_KEY = "openvpm.cookie-consent.v1";
export const COOKIE_PREFERENCES_EVENT = "openvpm:cookie-preferences";
export type CookieConsentChoice = "essential" | "analytics";

/**
 * Reopen the consent panel from anywhere (sidebar footer, portal footer).
 * A window event instead of context so server layouts can render the trigger.
 */
export function openCookiePreferences(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(COOKIE_PREFERENCES_EVENT));
}

export function CookiePreferencesLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openCookiePreferences}
      className={className ?? "underline-offset-2 hover:underline"}
    >
      Cookie preferences
    </button>
  );
}

type ConsentStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): ConsentStorage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function readCookieConsent(
  storage: ConsentStorage | null = browserStorage()
): CookieConsentChoice | null {
  try {
    const value = storage?.getItem(COOKIE_CONSENT_STORAGE_KEY);
    return value === "essential" || value === "analytics" ? value : null;
  } catch {
    return null;
  }
}

export function writeCookieConsent(
  choice: CookieConsentChoice,
  storage: ConsentStorage | null = browserStorage()
): void {
  try {
    storage?.setItem(COOKIE_CONSENT_STORAGE_KEY, choice);
  } catch {
    // Private browsing or locked-down clients can reject localStorage writes.
  }
}

export function CookieConsent() {
  const [choice, setChoice] = useState<CookieConsentChoice | null>(null);
  const [ready, setReady] = useState(false);
  const [preferencePanelOpen, setPreferencePanelOpen] = useState(false);

  useEffect(() => {
    setChoice(readCookieConsent());
    setReady(true);
  }, []);

  useEffect(() => {
    const open = () => setPreferencePanelOpen(true);
    window.addEventListener(COOKIE_PREFERENCES_EVENT, open);
    return () => window.removeEventListener(COOKIE_PREFERENCES_EVENT, open);
  }, []);

  function saveChoice(nextChoice: CookieConsentChoice) {
    writeCookieConsent(nextChoice);
    setChoice(nextChoice);
    setPreferencePanelOpen(false);
  }

  const panelOpen = ready && (choice === null || preferencePanelOpen);

  return (
    <>
      {choice === "analytics" ? <Analytics /> : null}
      {panelOpen ? (
        <div
          role="region"
          aria-label="Cookie preferences"
          className="fixed inset-x-3 bottom-3 z-[90] mx-auto max-w-3xl rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg sm:inset-x-6 sm:bottom-6"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-heading text-base font-semibold">
                Cookie preferences
              </p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                OpenVPM uses essential cookies for secure sign-in. Optional
                analytics help us spot reliability issues and improve the app.
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => saveChoice("essential")}
              >
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Essential Only
              </Button>
              <Button
                type="button"
                className="gap-2"
                onClick={() => saveChoice("analytics")}
              >
                <Check className="h-4 w-4" aria-hidden="true" />
                Allow Analytics
              </Button>
              {choice !== null ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close cookie preferences"
                  onClick={() => setPreferencePanelOpen(false)}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
