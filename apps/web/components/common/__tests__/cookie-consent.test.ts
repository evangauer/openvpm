import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COOKIE_CONSENT_STORAGE_KEY,
  readCookieConsent,
  writeCookieConsent,
  type CookieConsentChoice,
} from "../cookie-consent";

function memoryStorage(initial?: string) {
  const state = new Map<string, string>();
  if (initial) state.set(COOKIE_CONSENT_STORAGE_KEY, initial);

  return {
    getItem: (key: string) => state.get(key) ?? null,
    setItem: (key: string, value: string) => {
      state.set(key, value);
    },
  };
}

describe("cookie consent storage", () => {
  it.each<CookieConsentChoice>(["essential", "analytics"])(
    "persists the %s choice",
    (choice) => {
      const storage = memoryStorage();

      writeCookieConsent(choice, storage);

      expect(readCookieConsent(storage)).toBe(choice);
    }
  );

  it("ignores missing, malformed, or inaccessible storage", () => {
    expect(readCookieConsent(memoryStorage())).toBeNull();
    expect(readCookieConsent(memoryStorage("unexpected"))).toBeNull();
    expect(
      readCookieConsent({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => undefined,
      })
    ).toBeNull();
  });
});

describe("cookie consent analytics gate", () => {
  it("mounts analytics only from the consent-aware component", () => {
    const component = readFileSync(
      "components/common/cookie-consent.tsx",
      "utf8"
    );
    const layout = readFileSync("app/layout.tsx", "utf8");
    const providers = readFileSync("lib/providers.tsx", "utf8");

    expect(component).toContain(
      'import { Analytics } from "@vercel/analytics/next"'
    );
    expect(component).toContain('choice === "analytics" ? <Analytics /> : null');
    expect(component).toContain("Essential Only");
    expect(component).toContain("Allow Analytics");
    expect(layout).not.toContain("@vercel/analytics/next");
    expect(providers).toContain("<CookieConsent />");
  });

  it("keeps saved consent preferences reversible", () => {
    const component = readFileSync(
      "components/common/cookie-consent.tsx",
      "utf8"
    );
    const sidebar = readFileSync("components/layout/sidebar.tsx", "utf8");
    const portalLayout = readFileSync("app/portal/layout.tsx", "utf8");

    // The panel reopens via a window event; no floating button that can
    // overlap page content. Both surfaces (app sidebar, portal footer)
    // render a reopen trigger.
    expect(component).toContain("COOKIE_PREFERENCES_EVENT");
    expect(component).toContain("window.addEventListener(COOKIE_PREFERENCES_EVENT");
    expect(component).toContain("setPreferencePanelOpen(true)");
    expect(component).toContain("setPreferencePanelOpen(false)");
    expect(component).toContain('aria-label="Close cookie preferences"');
    expect(component).not.toContain("fixed bottom-3 left-3");
    expect(sidebar).toContain("openCookiePreferences");
    expect(portalLayout).toContain("CookiePreferencesLink");
  });
});
