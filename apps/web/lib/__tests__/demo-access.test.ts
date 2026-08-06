import { describe, expect, it } from "vitest";
import {
  createDemoAccessToken,
  DEMO_ACCESS_COOKIE_NAME,
  demoAccessEmailHash,
  demoAccessTokenFromRequest,
  isDemoRole,
  normalizeDemoAccessEmail,
  verifyDemoAccessToken,
} from "@/lib/demo-access";

const SECRET = "test-secret-at-least-32-characters-long";
const NOW = new Date("2026-08-06T18:00:00Z");

describe("demo access tokens", () => {
  it("normalizes and hashes email deterministically", () => {
    expect(normalizeDemoAccessEmail(" Dr.Admin@Example.COM ")).toBe(
      "dr.admin@example.com"
    );
    expect(demoAccessEmailHash(" Dr.Admin@Example.COM ")).toBe(
      demoAccessEmailHash("dr.admin@example.com")
    );
  });

  it("signs a short-lived token without exposing the raw email", () => {
    const token = createDemoAccessToken("doctor@example.com", {
      now: NOW,
      secret: SECRET,
    });

    expect(token).toBeTruthy();
    expect(token).not.toContain("doctor@example.com");
    expect(
      verifyDemoAccessToken(token, {
        now: new Date("2026-08-07T18:00:00Z"),
        secret: SECRET,
      })
    ).toMatchObject({
      v: 1,
      emailHash: demoAccessEmailHash("doctor@example.com"),
    });
  });

  it("rejects tampered and expired tokens", () => {
    const token = createDemoAccessToken("doctor@example.com", {
      now: NOW,
      secret: SECRET,
    });
    expect(token).toBeTruthy();

    expect(
      verifyDemoAccessToken(`${token}x`, { now: NOW, secret: SECRET })
    ).toBeNull();
    expect(
      verifyDemoAccessToken(token, {
        now: new Date("2026-08-14T18:00:01Z"),
        secret: SECRET,
      })
    ).toBeNull();
  });

  it("reads the signed cookie from NextAuth-style request headers", () => {
    const token = createDemoAccessToken("doctor@example.com", {
      now: NOW,
      secret: SECRET,
    });
    expect(
      demoAccessTokenFromRequest({
        headers: { cookie: `other=1; ${DEMO_ACCESS_COOKIE_NAME}=${token}` },
      })
    ).toBe(token);
  });

  it("accepts only known seeded demo roles", () => {
    expect(isDemoRole("admin")).toBe(true);
    expect(isDemoRole("front_desk")).toBe(true);
    expect(isDemoRole("owner")).toBe(false);
  });
});
