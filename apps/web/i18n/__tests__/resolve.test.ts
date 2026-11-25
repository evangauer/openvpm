import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE } from "../config";
import { resolveLanguage } from "../resolve";

describe("resolveLanguage", () => {
  it("lets a supported cookie win over Accept-Language", () => {
    expect(
      resolveLanguage({
        cookie: "it",
        acceptLanguage: "es-MX,es;q=0.9,en;q=0.8",
      }),
    ).toBe("it");
    expect(
      resolveLanguage({
        cookie: "ES-419",
        acceptLanguage: "en-US,en;q=0.9",
      }),
    ).toBe("es-419");
  });

  it("ignores an unsupported cookie and matches Accept-Language", () => {
    expect(
      resolveLanguage({
        cookie: "es-MX",
        acceptLanguage: "it-CH,it;q=0.9,en;q=0.8",
      }),
    ).toBe("it");
    expect(
      resolveLanguage({
        cookie: "fr",
        acceptLanguage: "es-ES,es;q=0.8,en;q=0.5",
      }),
    ).toBe("es-419");
  });

  it("maps Spanish and Italian ranges and falls back to English", () => {
    expect(resolveLanguage({ acceptLanguage: "es" })).toBe("es-419");
    expect(resolveLanguage({ acceptLanguage: "es-MX,es;q=0.9,en;q=0.8" })).toBe(
      "es-419",
    );
    expect(resolveLanguage({ acceptLanguage: "it-IT" })).toBe("it");
    expect(resolveLanguage({ acceptLanguage: "en-GB,en;q=0.9" })).toBe("en");
    expect(
      resolveLanguage({ acceptLanguage: "en;q=0.4,it;q=0.9,fr;q=0.8" }),
    ).toBe("it");
    expect(resolveLanguage({ acceptLanguage: "fr-FR,fr;q=0.9" })).toBe("en");
    expect(resolveLanguage({ acceptLanguage: "*" })).toBe("en");
    expect(resolveLanguage({})).toBe(DEFAULT_LANGUAGE);
    expect(resolveLanguage({ cookie: "  ", acceptLanguage: "" })).toBe("en");
  });
});
