import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AUTH_PASSWORD_MAX_LENGTH,
  AUTH_PASSWORD_MIN_LENGTH,
} from "../auth-password-policy";
import {
  AUTH_EMAIL_MAX_LENGTH,
  AUTH_LOCATION_NAME_MAX_LENGTH,
  AUTH_NAME_MAX_LENGTH,
  AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH,
  AUTH_ONBOARDING_TEAM_MEMBER_NAME_MAX_LENGTH,
  AUTH_PRACTICE_NAME_MAX_LENGTH,
  isAuthEmailLengthValid,
  isOptionalAuthTextValid,
  isRequiredAuthTextValid,
} from "../auth-input-policy";

describe("auth password UI policy", () => {
  const registerSource = readFileSync("app/(auth)/register/page.tsx", "utf8");
  const loginSource = readFileSync("app/(auth)/login/page.tsx", "utf8");
  const forgotSource = readFileSync(
    "app/(auth)/forgot-password/page.tsx",
    "utf8"
  );
  const resetSource = readFileSync("app/(auth)/reset-password/page.tsx", "utf8");
  const inviteSource = readFileSync("app/(auth)/accept-invite/page.tsx", "utf8");
  const authRouterSource = readFileSync("server/routers/auth.ts", "utf8");
  const authSource = readFileSync("lib/auth.ts", "utf8");
  const sources = [registerSource, resetSource, inviteSource].join("\n");

  it("keeps public auth password inputs aligned to the shared policy", () => {
    expect(AUTH_PASSWORD_MIN_LENGTH).toBe(8);
    expect(AUTH_PASSWORD_MAX_LENGTH).toBe(128);

    for (const source of [registerSource, resetSource, inviteSource]) {
      expect(source).toContain(
        'AUTH_PASSWORD_MAX_LENGTH,\n  AUTH_PASSWORD_MIN_LENGTH,'
      );
      expect(source).toContain("minLength={AUTH_PASSWORD_MIN_LENGTH}");
      expect(source).toContain("maxLength={AUTH_PASSWORD_MAX_LENGTH}");
    }

    expect(registerSource).toContain(
      "password.length < AUTH_PASSWORD_MIN_LENGTH"
    );
    expect(registerSource).toContain(
      "password.length > AUTH_PASSWORD_MAX_LENGTH"
    );
    expect(resetSource).toContain("const canSubmit =");
    expect(resetSource).toContain("password.length >= AUTH_PASSWORD_MIN_LENGTH");
    expect(resetSource).toContain("password.length <= AUTH_PASSWORD_MAX_LENGTH");
    expect(resetSource).toContain("disabled={!canSubmit || reset.isPending}");
    expect(inviteSource).toContain("const passwordMeetsPolicy =");
    expect(inviteSource).toContain("const canSubmit =");
    expect(inviteSource).toContain("passwordMeetsPolicy && password === confirm");
    expect(inviteSource).toContain("disabled={!canSubmit || accept.isPending}");
    expect(sources).not.toContain("minLength={8}");
    expect(sources).not.toContain("password.length < 8");
    expect(resetSource).not.toContain("disabled={reset.isPending}");
    expect(inviteSource).not.toContain("disabled={accept.isPending}");
  });

  it("keeps public auth email and signup text bounds aligned", () => {
    expect(AUTH_EMAIL_MAX_LENGTH).toBe(255);
    expect(AUTH_NAME_MAX_LENGTH).toBe(255);
    expect(AUTH_PRACTICE_NAME_MAX_LENGTH).toBe(255);
    expect(AUTH_LOCATION_NAME_MAX_LENGTH).toBe(255);
    expect(AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH).toBe(120);
    expect(AUTH_ONBOARDING_TEAM_MEMBER_NAME_MAX_LENGTH).toBe(80);
    expect(isAuthEmailLengthValid(" clinic@example.com ")).toBe(true);
    expect(
      isAuthEmailLengthValid(`${"a".repeat(AUTH_EMAIL_MAX_LENGTH)}@x.test`)
    ).toBe(false);
    expect(
      isRequiredAuthTextValid(" Vet Clinic ", AUTH_PRACTICE_NAME_MAX_LENGTH, 2)
    ).toBe(true);
    expect(isRequiredAuthTextValid(" V ", AUTH_PRACTICE_NAME_MAX_LENGTH, 2)).toBe(
      false
    );
    expect(
      isOptionalAuthTextValid(
        "A".repeat(AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH + 1),
        AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH
      )
    ).toBe(false);

    expect(authRouterSource).toContain(".max(AUTH_EMAIL_MAX_LENGTH)");
    expect(authRouterSource).toContain(
      'authTextInput("Name", 2, AUTH_NAME_MAX_LENGTH)'
    );
    expect(authRouterSource).toContain("AUTH_PRACTICE_NAME_MAX_LENGTH");
    expect(authRouterSource).toContain("AUTH_LOCATION_NAME_MAX_LENGTH");
    expect(authRouterSource).toContain(
      "AUTH_ONBOARDING_LOGO_NAME_MAX_LENGTH"
    );
    expect(authRouterSource).toContain(
      "AUTH_ONBOARDING_TEAM_MEMBER_NAME_MAX_LENGTH"
    );
    expect(authSource).toContain(
      "LOGIN_EMAIL_MAX_LENGTH = AUTH_EMAIL_MAX_LENGTH"
    );

    expect(registerSource).toContain("AUTH_PRACTICE_NAME_MAX_LENGTH");
    expect(registerSource).toContain("AUTH_EMAIL_MAX_LENGTH");
    expect(registerSource).toContain(
      "maxLength={AUTH_PRACTICE_NAME_MAX_LENGTH}"
    );
    expect(registerSource).toContain("maxLength={AUTH_EMAIL_MAX_LENGTH}");
    expect(registerSource).toContain("isAuthEmailLengthValid(email)");
    expect(registerSource).toContain("const canSubmit =");
    expect(registerSource).toContain(
      "disabled={!canSubmit || loading || registerMutation.isPending}"
    );

    for (const source of [loginSource, forgotSource]) {
      expect(source).toContain("AUTH_EMAIL_MAX_LENGTH");
      expect(source).toContain("maxLength={AUTH_EMAIL_MAX_LENGTH}");
      expect(source).toContain('import { isValidEmail } from "@/lib/utils"');
      expect(source).toContain(
        "isAuthEmailLengthValid(email) && isValidEmail(email)"
      );
    }
    expect(loginSource).toContain("maxLength={AUTH_PASSWORD_MAX_LENGTH}");
    expect(loginSource).toContain("const passwordMeetsPolicy =");
    expect(loginSource).toContain(
      "password.length > 0 && password.length <= AUTH_PASSWORD_MAX_LENGTH"
    );
    expect(loginSource).toContain(
      "emailIsValid && (DEMO_MODE || passwordMeetsPolicy)"
    );
    expect(loginSource).toContain("if (!canSubmit) return;");
    expect(loginSource).toContain("email.trim().toLowerCase()");
    expect(loginSource).toContain("disabled={!canSubmit || loading}");
    expect(loginSource).not.toContain(
      'type="submit"\n            disabled={loading}'
    );
    expect(forgotSource).toContain("const canSubmit =");
    expect(forgotSource).toContain("email.trim().toLowerCase()");
    expect(forgotSource).toContain("disabled={!canSubmit || request.isPending}");
  });
});
