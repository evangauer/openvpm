import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostedRlsRoleViolations,
  shouldAssertHostedRlsRole,
} from "../rls-assertion";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hostedRlsRoleViolations", () => {
  it("flags superuser, bypassrls, and tenant table ownership", () => {
    expect(
      hostedRlsRoleViolations({
        currentUser: "postgres",
        rolBypassRls: true,
        rolSuper: true,
        ownsTenantTables: true,
      })
    ).toEqual([
      "role is superuser",
      "role has BYPASSRLS",
      "role owns tenant tables",
    ]);
  });

  it("allows a least-privilege app role", () => {
    expect(
      hostedRlsRoleViolations({
        currentUser: "openpims_app",
        rolBypassRls: false,
        rolSuper: false,
        ownsTenantTables: false,
      })
    ).toEqual([]);
  });
});

describe("shouldAssertHostedRlsRole", () => {
  it("enables forced hosted RLS assertions with padded env flag values", () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", " true ");
    vi.stubEnv("ENFORCE_RLS_BOOT_ASSERTION", " true ");

    expect(shouldAssertHostedRlsRole()).toBe(true);
  });

  it("treats padded skip values as an explicit hosted RLS assertion skip", () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("ENFORCE_RLS_BOOT_ASSERTION", "true");
    vi.stubEnv("SKIP_RLS_BOOT_ASSERTION", " true ");

    expect(shouldAssertHostedRlsRole()).toBe(false);
  });

  it("keeps hosted RLS assertion flags disabled for non-true values", () => {
    vi.stubEnv("HOSTED_BILLING_ENABLED", "true");
    vi.stubEnv("ENFORCE_RLS_BOOT_ASSERTION", "TRUE");

    expect(shouldAssertHostedRlsRole()).toBe(false);
  });
});
