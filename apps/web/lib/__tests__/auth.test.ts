import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  LOGIN_EMAIL_MAX_LENGTH,
  authOptions,
  clientIpFromAuthRequest,
  loginRateLimitKeys,
  parseLoginCredentials,
} from "../auth";
import { AUTH_PASSWORD_MAX_LENGTH } from "../auth-password";
import {
  hasBlankConfiguredNextAuthSecret,
  nextAuthSecret,
} from "../auth-secret";

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

describe("loginRateLimitKeys", () => {
  it("normalizes email and scopes by email plus IP", () => {
    expect(loginRateLimitKeys(" Admin@Example.COM ", "203.0.113.10")).toEqual({
      emailKey: "login:email:admin@example.com",
      ipKey: "login:ip:203.0.113.10",
    });
  });
});

describe("clientIpFromAuthRequest", () => {
  it("prefers the first forwarded IP", () => {
    expect(
      clientIpFromAuthRequest({
        headers: { "x-forwarded-for": "203.0.113.10, 198.51.100.5" },
      })
    ).toBe("203.0.113.10");
  });

  it("falls back to x-real-ip and then unknown", () => {
    expect(clientIpFromAuthRequest({ headers: { "x-real-ip": "198.51.100.5" } })).toBe(
      "198.51.100.5"
    );
    expect(clientIpFromAuthRequest({ headers: {} })).toBe("unknown");
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
  it("caps encrypted clinic sessions at one long shift", () => {
    expect(AUTH_SESSION_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
    expect(authOptions.session).toMatchObject({
      strategy: "jwt",
      maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    });
    expect(authOptions.jwt).toMatchObject({
      maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
    });
  });

  it("parses credentials before rate-limit, lookup, or bcrypt work", () => {
    const source = readFileSync("lib/auth.ts", "utf8");
    const authorizeSource = source.slice(
      source.indexOf("async authorize(credentials, req)"),
    );

    expect(
      authorizeSource.indexOf("parseLoginCredentials(credentials)"),
    ).toBeLessThan(
      authorizeSource.indexOf("rateLimit({"),
    );
    expect(
      authorizeSource.indexOf("parseLoginCredentials(credentials)"),
    ).toBeLessThan(
      authorizeSource.indexOf("withSystem(db"),
    );
    expect(
      authorizeSource.indexOf("parseLoginCredentials(credentials)"),
    ).toBeLessThan(
      authorizeSource.indexOf("compare(password"),
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
