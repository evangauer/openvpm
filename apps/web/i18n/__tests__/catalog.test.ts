import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import es419 from "@/messages/es-419.json";
import itMessages from "@/messages/it.json";
import { checkCatalogs } from "../catalog-check";
import { SUPPORTED_LANGUAGES } from "../config";
import type { MessageTree } from "../merge";

const messagesDir = resolve(process.cwd(), "messages");

describe("message catalogs", () => {
  it("parses every supported catalog as JSON", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const parsed: unknown = JSON.parse(
        readFileSync(resolve(messagesDir, `${language}.json`), "utf8"),
      );
      expect(parsed && typeof parsed === "object" && !Array.isArray(parsed)).toBe(
        true,
      );
    }
  });

  it("accepts the shipped catalogs", () => {
    expect(checkCatalogs({ en, "es-419": es419, it: itMessages }).errors).toEqual([]);
  });

  it("rejects orphan keys, broken ICU, and placeholder mismatches", () => {
    const orphan: MessageTree = {
      auth: {
        signIn: {
          notInEnglish: "Extra",
        },
      },
    };
    expect(checkCatalogs({ en, "es-419": es419, it: orphan }).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          language: "it",
          path: "auth.signIn.notInEnglish",
        }),
      ]),
    );

    const mismatch: MessageTree = {
      auth: {
        signIn: {
          rateLimitedHours: "Riprova tra {hours} ore.",
        },
      },
    };
    expect(
      checkCatalogs({ en, "es-419": es419, it: mismatch }).errors,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          language: "it",
          path: "auth.signIn.rateLimitedHours",
        }),
      ]),
    );

    const broken: MessageTree = {
      auth: {
        signIn: {
          submit: "{count, plural, one {",
        },
      },
    };
    expect(
      checkCatalogs({ en, "es-419": es419, it: broken }).errors.some((issue) =>
        issue.message.startsWith("Invalid ICU"),
      ),
    ).toBe(true);
  });

  it("reports missing translations without treating them as errors", () => {
    const partial: MessageTree = {
      auth: { signIn: { submit: "Accedi" } },
    };
    const result = checkCatalogs({ en, "es-419": es419, it: partial });
    expect(result.errors).toEqual([]);
    const italian = result.coverage.find((item) => item.language === "it");
    expect(italian?.missing).toBeGreaterThan(0);
    expect(italian?.percentMissing).toBeGreaterThan(0);
    expect(italian?.percentMissing).toBeLessThan(100);
  });

  it("keeps checkout copy inline and moves the practice sign-in strings", () => {
    const source = readFileSync(
      resolve(process.cwd(), "app/(auth)/login/page.tsx"),
      "utf8",
    );
    expect(source).toContain('useTranslations("auth.signIn")');
    expect(source).toContain("<LanguageSwitcher />");
    expect(source).not.toContain("Sign in to your practice");
    expect(source).not.toContain("Forgot your password?");
    expect(source).not.toContain("Register your practice");
    expect(source).not.toContain("Signing in...");
    expect(source).not.toContain("Enter your password");
    expect(source).not.toContain("you@clinic.com");
    expect(source).not.toContain("Sign-in is temporarily unavailable");
    expect(source).not.toContain("Don't have an account?");
    expect(source).toContain(
      "Checkout completed. Sign in to open your clinic workspace. Your billing status updates after Stripe confirms checkout.",
    );
    expect(source).toContain(
      "Your account is saved, but your trial has not started. Sign in to resume secure checkout in Plan & Billing. No subscription charge was made.",
    );

    const layout = readFileSync(resolve(process.cwd(), "app/layout.tsx"), "utf8");
    expect(layout).toContain("generateMetadata");
    expect(layout).toContain('getTranslations("metadata")');
    expect(layout).toContain("lang={language}");
    expect(layout).not.toContain('lang="en"');
    expect(layout).not.toContain("Skip to main content");

    const errorView = readFileSync(
      resolve(process.cwd(), "components/common/app-error-view.tsx"),
      "utf8",
    );
    expect(errorView).toContain('useTranslations("errors")');
    expect(errorView).not.toContain("Something went wrong");
    expect(errorView).not.toContain("Try Again");

    const notFound = readFileSync(
      resolve(process.cwd(), "components/common/not-found-view.tsx"),
      "utf8",
    );
    expect(notFound).toContain('useTranslations("notFound")');
    expect(notFound).not.toContain("Page not found");
    expect(notFound).not.toContain("Go to Dashboard");
  });
});
