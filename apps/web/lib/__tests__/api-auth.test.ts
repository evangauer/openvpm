import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import {
  generateApiKey,
  extractApiKey,
  hasScope,
  API_KEY_PREFIX,
  API_SCOPES,
  apiScopesHaveValidDependencies,
} from "../api-auth";

describe("generateApiKey", () => {
  it("produces a prefixed key whose hash verifies and whose prefix is the first 12 chars", async () => {
    const { raw, prefix, hash } = await generateApiKey();
    expect(raw.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(prefix).toBe(raw.slice(0, 12));
    expect(await bcrypt.compare(raw, hash)).toBe(true);
  });

  it(
    "does not verify against a different key",
    async () => {
      const a = await generateApiKey();
      const b = await generateApiKey();
      expect(await bcrypt.compare(b.raw, a.hash)).toBe(false);
      expect(a.raw).not.toBe(b.raw);
    },
    15_000,
  );
});

describe("extractApiKey", () => {
  it("reads a Bearer token", () => {
    const h = new Headers({ authorization: "Bearer ovpm_abc123" });
    expect(extractApiKey(h)).toBe("ovpm_abc123");
  });

  it("reads X-API-Key when no Bearer present", () => {
    const h = new Headers({ "x-api-key": "ovpm_xyz789" });
    expect(extractApiKey(h)).toBe("ovpm_xyz789");
  });

  it("prefers Bearer over X-API-Key", () => {
    const h = new Headers({
      authorization: "Bearer ovpm_bearer",
      "x-api-key": "ovpm_header",
    });
    expect(extractApiKey(h)).toBe("ovpm_bearer");
  });

  it("returns null when no key is present", () => {
    expect(extractApiKey(new Headers())).toBeNull();
  });

  it("returns null for a non-Bearer Authorization scheme", () => {
    const h = new Headers({ authorization: "Basic dXNlcjpwYXNz" });
    expect(extractApiKey(h)).toBeNull();
  });
});

describe("hasScope", () => {
  it("grants when the exact scope is present", () => {
    expect(hasScope(["clients:read", "patients:read"], "clients:read")).toBe(true);
  });

  it("denies when the scope is absent", () => {
    expect(hasScope(["patients:read"], "appointments:write")).toBe(false);
  });

  it("grants any scope when the wildcard is present", () => {
    expect(hasScope(["*"], "appointments:write")).toBe(true);
  });

  it("denies on an empty scope list", () => {
    expect(hasScope([], "clients:read")).toBe(false);
  });
});

describe("API_SCOPES", () => {
  it("includes separate agent run/write scopes and the wildcard", () => {
    expect(API_SCOPES).toContain("agent:run");
    expect(API_SCOPES).toContain("agent:write");
    expect(API_SCOPES).toContain("*");
  });

  it("treats agent:write as a companion to agent:run or the wildcard", () => {
    expect(apiScopesHaveValidDependencies(["agent:run"])).toBe(true);
    expect(apiScopesHaveValidDependencies(["agent:run", "agent:write"])).toBe(
      true
    );
    expect(apiScopesHaveValidDependencies(["*"])).toBe(true);
    expect(apiScopesHaveValidDependencies(["*", "agent:write"])).toBe(true);
    expect(apiScopesHaveValidDependencies(["agent:write"])).toBe(false);
    expect(
      apiScopesHaveValidDependencies(["agent:write", "appointments:write"])
    ).toBe(false);
  });
});
