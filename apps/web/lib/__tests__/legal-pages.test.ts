import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("legal pages", () => {
  it("publishes terms and privacy with the load-bearing commitments", () => {
    const terms = readFileSync("app/legal/terms/page.tsx", "utf8");
    const privacy = readFileSync("app/legal/privacy/page.tsx", "utf8");

    expect(terms).toContain("Terms of Service");
    expect(terms).toContain("Your data belongs to you");
    expect(terms).toContain("not a veterinarian");
    expect(terms).toContain("hello@openvpm.com");
    expect(privacy).toContain("Privacy Policy");
    expect(privacy).toContain("We do not sell personal data");
    expect(privacy).toContain("row-level security");
    expect(privacy).toContain("hello@openvpm.com");
  });

  it("links the terms from signup and privacy from the portal", () => {
    const register = readFileSync("app/(auth)/register/page.tsx", "utf8");
    const portal = readFileSync("components/portal/portal-shell.tsx", "utf8");

    expect(register).toContain('href="/legal/terms"');
    expect(register).toContain('href="/legal/privacy"');
    expect(portal).toContain('href="/legal/privacy"');
  });

  it("keeps legal pages public in the auth middleware", () => {
    const middleware = readFileSync("middleware.ts", "utf8");
    expect(middleware).toContain('"/legal",');
  });
});
