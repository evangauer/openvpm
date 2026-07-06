import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_KEY_HASH_COST, PASSWORD_HASH_COST } from "../auth-hashing";

const PASSWORD_HASH_SOURCES = [
  "server/routers/auth.ts",
  "server/routers/settings.ts",
];

describe("auth hash costs", () => {
  it("keeps password and API key hash costs at the production minimum", () => {
    expect(PASSWORD_HASH_COST).toBeGreaterThanOrEqual(12);
    expect(API_KEY_HASH_COST).toBeGreaterThanOrEqual(12);
  });

  it("routes password hashing through the shared cost constant", () => {
    for (const file of PASSWORD_HASH_SOURCES) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("PASSWORD_HASH_COST");
      expect(source).not.toMatch(/hash\([^,\n]+,\s*1[01]\)/);
    }
  });

  it("routes API key hashing through the shared cost constant", () => {
    const source = readFileSync("lib/api-auth.ts", "utf8");

    expect(source).toContain("API_KEY_HASH_COST");
    expect(source).not.toMatch(/bcrypt\.hash\([^,\n]+,\s*1[01]\)/);
  });

  it("keeps the dummy login hash at the password hash cost", () => {
    const source = readFileSync("lib/auth.ts", "utf8");

    expect(source).toContain(`$2a$${PASSWORD_HASH_COST}$`);
    expect(source).not.toContain("$2a$10$");
  });
});
