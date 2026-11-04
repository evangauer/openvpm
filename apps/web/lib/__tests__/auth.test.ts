import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_EMAIL_MAX_LENGTH,
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
