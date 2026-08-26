import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("portal branding UI", () => {
  const shell = readFileSync("components/portal/portal-shell.tsx", "utf8");
  const layout = readFileSync("app/portal/layout.tsx", "utf8");
  const portalPages = [
    "app/portal/[token]/page.tsx",
    "app/portal/[token]/book/page.tsx",
    "app/portal/[token]/appointments/page.tsx",
    "app/portal/[token]/messages/page.tsx",
    "app/portal/[token]/invoices/page.tsx",
    "app/portal/[token]/pets/[petId]/page.tsx",
  ].map((path) => readFileSync(path, "utf8"));

  it("uses one token-aware shell across every client portal route", () => {
    expect(layout).toContain("<PortalShell>{children}</PortalShell>");
    expect(shell).toContain("trpc.portal.getClient.useQuery");
    expect(shell).toContain("practice?.logoUrl");
    expect(shell).toContain("practiceName");
    expect(shell).toContain("Pet Portal");
    expect(shell).toContain("Powered by OpenVPM");
  });

  it("keeps safe branding fallbacks for unbranded or invalid links", () => {
    expect(shell).toContain('practice?.name ?? "OpenVPM"');
    expect(shell).toContain("DEFAULT_PORTAL_BRAND_COLOR");
    expect(shell).toContain("<PawMark");
    expect(shell).toContain('initials(practiceName) || "VP"');
    expect(shell).toContain('retry: false');
  });

  it("scopes the tenant accent variables to the portal shell", () => {
    expect(shell).toContain('"--primary": brandHsl');
    expect(shell).toContain('"--ring": brandHsl');
    for (const page of portalPages) {
      expect(page).not.toMatch(/(?:bg|text|border|ring)-teal-/);
    }
  });

  it("retains accessible structure and logo alternatives", () => {
    expect(shell).toContain('id="main-content"');
    expect(shell).toContain('alt={`${practiceName} logo`}');
    expect(shell).toContain('href="/legal/privacy"');
  });
});
