import { IntlMessageFormat } from "intl-messageformat";
import { IntlError, IntlErrorCode } from "next-intl";
import { describe, expect, it } from "vitest";
import {
  INVALID_LOGIN_MESSAGE,
  loginErrorMessage,
  loginRateLimitedErrorCode,
} from "@/lib/login-error-message";
import en from "@/messages/en.json";
import itMessages from "@/messages/it.json";
import { messagesFor } from "../catalog";
import { getIntlMessageFallback, onIntlError } from "../errors";
import { deepMergeMessages, lookupMessage, type MessageTree } from "../merge";
import { signInErrorMessage, type SignInFailure } from "../sign-in-error";

describe("English fallback", () => {
  it("renders the English string when a key is missing from Italian", () => {
    const partial: MessageTree = {
      auth: { signIn: { submit: "Accedi" } },
    };
    const merged = deepMergeMessages(en, partial);
    expect(lookupMessage(merged, "auth.signIn.submit")).toBe("Accedi");
    expect(lookupMessage(merged, "auth.signIn.email")).toBe("Email");
    expect(lookupMessage(merged, "errors.title")).toBe("Something went wrong");
    expect(
      getIntlMessageFallback({
        error: new IntlError(IntlErrorCode.MISSING_MESSAGE, "auth.signIn.email"),
        namespace: "auth.signIn",
        key: "email",
      }),
    ).toBe("Email");
    expect(
      getIntlMessageFallback({
        error: new IntlError(IntlErrorCode.MISSING_MESSAGE, "missing"),
        key: "not.a.real.key",
      }),
    ).toBe("not.a.real.key");
    expect(() =>
      onIntlError(
        new IntlError(IntlErrorCode.MISSING_MESSAGE, "auth.signIn.email"),
      ),
    ).not.toThrow();
  });

  it("keeps shipped Italian strings and fills anything absent from English", () => {
    const merged = messagesFor("it");
    expect(lookupMessage(merged, "auth.signIn.submit")).toBe("Accedi");
    expect(lookupMessage(merged, "metadata.title")).toBe(itMessages.metadata.title);
    expect(messagesFor("en")).toBe(en);
  });
});

describe("sign-in English copy", () => {
  function translate(
    key: "invalid" | "unavailable" | "rateLimitedMinutes" | "rateLimitedHours",
    values?: { count: number },
  ): string {
    const template = en.auth.signIn[key];
    return String(new IntlMessageFormat(template, "en").format(values ?? {}));
  }

  it("matches the existing English sign-in errors", () => {
    const credentials = (error: string | undefined): SignInFailure => ({
      kind: "credentials",
      error,
    });

    expect(signInErrorMessage(credentials("CredentialsSignin"), translate)).toBe(
      INVALID_LOGIN_MESSAGE,
    );
    expect(signInErrorMessage(credentials(undefined), translate)).toBe(
      loginErrorMessage(undefined),
    );
    expect(signInErrorMessage({ kind: "unavailable" }, translate)).toBe(
      "Sign-in is temporarily unavailable. Please try again.",
    );

    for (const seconds of [1, 30, 59, 60, 61, 3600, 3601, 7200]) {
      const code = loginRateLimitedErrorCode(seconds);
      expect(signInErrorMessage(credentials(code), translate)).toBe(
        loginErrorMessage(code),
      );
    }
  });
});
