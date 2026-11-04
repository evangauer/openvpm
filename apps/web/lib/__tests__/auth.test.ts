import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_EMAIL_MAX_LENGTH,
  parseLoginCredentials,
} from "../auth";
import { AUTH_PASSWORD_MAX_LENGTH } from "../auth-password";
import {
  authSecretProblem,
  hasBlankConfiguredNextAuthSecret,
  nextAuthSecret,
  nextAuthSecretRejected,
  nextAuthSecretShortOverrideActive,
} from "../auth-secret";

const STRONG_SECRET = "q3vV9rJcK0m8yTfLw2ZpXa7Ns4Hd6Bu1Ee5Gi0Ko9Rs=";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("nextAuthSecret", () => {
  it("trims configured secrets", () => {
    vi.stubEnv("NEXTAUTH_SECRET", " auth-secret ");

    expect(nextAuthSecret()).toBe("auth-secret");
    expect(hasBlankConfiguredNextAuthSecret()).toBe(false);
  });

  it("treats whitespace-only configured secrets as blank", () => {
    vi.stubEnv("NEXTAUTH_SECRET", "   ");

    expect(nextAuthSecret()).toBeUndefined();
    expect(hasBlankConfiguredNextAuthSecret()).toBe(true);
  });

  it("does not flag a missing secret as an explicitly blank configuration", () => {
    const previous = process.env.NEXTAUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    try {
      expect(nextAuthSecret()).toBeUndefined();
      expect(hasBlankConfiguredNextAuthSecret()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = previous;
    }
  });
});

describe("authSecretProblem", () => {
  it("accepts a generated 32-byte base64 secret", () => {
    expect(authSecretProblem(STRONG_SECRET)).toBeNull();
    expect(authSecretProblem(` ${STRONG_SECRET}\n`)).toBeNull();
  });

  it.each([
    "docker-dev-secret-change-in-production",
    "generate-a-secret-with-openssl-rand-base64-32",
    "test-secret-at-least-32-characters-long",
    "openvpm-local-portal-metadata-secret",
    "ci-only-synthetic-nextauth-secret-not-for-deployment",
    " DOCKER-DEV-SECRET-CHANGE-IN-PRODUCTION ",
  ])("rejects the published placeholder %j", (value) => {
    expect(authSecretProblem(value)).toBe("known_public");
  });

  it("rejects secrets shorter than 32 characters", () => {
    expect(authSecretProblem("a".repeat(31))).toBe("too_short");
    expect(authSecretProblem("a".repeat(32))).toBeNull();
  });

  it("reports missing and blank secrets", () => {
    expect(authSecretProblem(undefined)).toBe("missing");
    expect(authSecretProblem("   ")).toBe("missing");
  });
});

describe("nextAuthSecretRejected", () => {
  it.each([
    ["the compose default", "docker-dev-secret-change-in-production"],
    ["the .env.example placeholder", "generate-a-secret-with-openssl-rand-base64-32"],
    ["a short secret", "short-secret"],
  ])("fails closed in production with %s", (_label, value) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_SECRET", value);

    expect(nextAuthSecretRejected()).toBe(true);
    expect(nextAuthSecret()).toBeUndefined();
  });

  it("fails closed in production when the secret is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_SECRET", undefined);

    expect(nextAuthSecretRejected()).toBe(true);
  });

  it("accepts a strong secret in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_SECRET", STRONG_SECRET);

    expect(nextAuthSecretRejected()).toBe(false);
    expect(nextAuthSecret()).toBe(STRONG_SECRET);
  });

  it("keeps development working with a placeholder secret", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXTAUTH_SECRET", "docker-dev-secret-change-in-production");

    expect(nextAuthSecretRejected()).toBe(false);
    expect(nextAuthSecret()).toBe("docker-dev-secret-change-in-production");
  });

  it("still rejects an explicitly blank secret outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXTAUTH_SECRET", "  ");

    expect(nextAuthSecretRejected()).toBe(true);
  });
});

describe("OPENVPM_ALLOW_SHORT_AUTH_SECRET", () => {
  it.each(["1", "true"])(
    "lets production serve on a short secret when set to %j",
    (flag) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXTAUTH_SECRET", "short-but-private");
      vi.stubEnv("OPENVPM_ALLOW_SHORT_AUTH_SECRET", flag);

      expect(nextAuthSecretRejected()).toBe(false);
      expect(nextAuthSecretShortOverrideActive()).toBe(true);
      expect(nextAuthSecret()).toBe("short-but-private");
    },
  );

  it("never excuses a published placeholder", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_SECRET", "docker-dev-secret-change-in-production");
    vi.stubEnv("OPENVPM_ALLOW_SHORT_AUTH_SECRET", "1");

    expect(nextAuthSecretRejected()).toBe(true);
    expect(nextAuthSecretShortOverrideActive()).toBe(false);
    expect(nextAuthSecret()).toBeUndefined();
  });

  it("never excuses a missing or blank secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPENVPM_ALLOW_SHORT_AUTH_SECRET", "1");

    vi.stubEnv("NEXTAUTH_SECRET", undefined);
    expect(nextAuthSecretRejected()).toBe(true);
    vi.stubEnv("NEXTAUTH_SECRET", "   ");
    expect(nextAuthSecretRejected()).toBe(true);
    expect(nextAuthSecretShortOverrideActive()).toBe(false);
  });

  it("is inactive when unset, falsy, or the secret is already strong", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTAUTH_SECRET", "short-but-private");
    vi.stubEnv("OPENVPM_ALLOW_SHORT_AUTH_SECRET", "0");
    expect(nextAuthSecretRejected()).toBe(true);

    vi.stubEnv("OPENVPM_ALLOW_SHORT_AUTH_SECRET", "1");
    vi.stubEnv("NEXTAUTH_SECRET", STRONG_SECRET);
    expect(nextAuthSecretShortOverrideActive()).toBe(false);
  });
});

describe("parseLoginCredentials", () => {
  it("normalizes accepted login credentials", () => {
    expect(
      parseLoginCredentials({
        email: " Admin@Example.COM ",
        password: "password123",
      })
    ).toEqual({
      email: "admin@example.com",
      password: "password123",
    });
  });

  it("keeps non-empty legacy password lengths eligible for verification", () => {
    expect(
      parseLoginCredentials({
        email: "admin@example.com",
        password: "secret",
      })
    ).toMatchObject({ email: "admin@example.com", password: "secret" });
  });

  it("rejects oversized login email and password inputs", () => {
    expect(
      parseLoginCredentials({
        email: `${"a".repeat(LOGIN_EMAIL_MAX_LENGTH)}@example.com`,
        password: "password123",
      })
    ).toBeNull();

    expect(
      parseLoginCredentials({
        email: "admin@example.com",
        password: "p".repeat(AUTH_PASSWORD_MAX_LENGTH + 1),
      })
    ).toBeNull();
  });
});

describe("credentials auth active-user lookup", () => {
  it("parses credentials before rate-limit, lookup, or bcrypt work", () => {
    const source = readFileSync("lib/auth.ts", "utf8");

    expect(source.indexOf("parseLoginCredentials(credentials)")).toBeLessThan(
      source.indexOf("reserveLoginAttempt(throttleKeys)")
    );
    expect(source.indexOf("parseLoginCredentials(credentials)")).toBeLessThan(
      source.indexOf("withSystem(db")
    );
    expect(source.indexOf("parseLoginCredentials(credentials)")).toBeLessThan(
      source.indexOf("compare(password")
    );
  });

  it("does not select soft-deleted users for password sign-in", () => {
    const source = readFileSync("lib/auth.ts", "utf8");

    expect(source).toContain("isNull(users.deletedAt)");
    expect(source).toMatch(
      /where\(\s*and\(\s*eq\(users\.email, email\),\s*isNull\(users\.deletedAt\)\s*\)\s*\)/s
    );
  });
});
