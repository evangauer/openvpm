import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 119,
    resetAt: new Date("2026-08-26T18:15:00Z"),
  })),
}));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: () => false,
  hasHostedFullAccess: () => true,
}));

const { portalRouter } = await import("../routers/portal");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";

function portalContext(db: Record<string, unknown>) {
  return {
    db,
    ip: "203.0.113.10",
    portalSessionId: "portal-token",
    portalClient: {
      id: CLIENT_ID,
      practiceId: PRACTICE_ID,
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: null,
    },
  } as never;
}

function createDb(brandColor: unknown) {
  const select = vi.fn((fields?: Record<string, unknown>) => {
    const names = Object.keys(fields ?? {}).sort().join(",");
    const rows = !fields
      ? [
          {
            id: CLIENT_ID,
            practiceId: PRACTICE_ID,
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            phone: null,
          },
        ]
      : names === "id"
        ? [{ id: PRACTICE_ID }]
        : names === "address,email,logoUrl,name,phone,settings,timezone"
          ? [
              {
                name: "  Harbor Veterinary  ",
                logoUrl: "/api/files/clinic/branding/logo.png",
                address: "1 Harbor Way",
                phone: "555-0100",
                email: "care@harbor.example",
                timezone: "America/New_York",
                settings: {
                  brandColor,
                  privateOperationalSetting: "must-not-leak",
                },
              },
            ]
          : names === "address,id,isPrimary,name,phone"
            ? []
            : names === "breed,color,dob,id,name,photoUrl,sex,species,status"
              ? []
              : [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(async () => rows),
      limit: vi.fn(async () => rows),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return builder;
  });

  const db: Record<string, unknown> = {
    select,
    execute: vi.fn(async () => undefined),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return db;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("portal tenant branding", () => {
  it("returns only the bounded, canonical clinic identity for a valid token", async () => {
    const result = await portalRouter
      .createCaller(portalContext(createDb(" #A1B2C3 ")))
      .getClient({ token: "portal-token" });

    expect(result.practice).toEqual({
      name: "Harbor Veterinary",
      logoUrl: "/api/files/clinic/branding/logo.png",
      brandColor: "#a1b2c3",
      address: "1 Harbor Way",
      phone: "555-0100",
      email: "care@harbor.example",
      timezone: "America/New_York",
    });
    expect(result.practice).not.toHaveProperty("settings");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("drops invalid legacy colors before they reach portal CSS", async () => {
    const result = await portalRouter
      .createCaller(
        portalContext(
          createDb("#123456; background: url(javascript:alert(1))"),
        ),
      )
      .getClient({ token: "portal-token" });

    expect(result.practice.brandColor).toBeNull();
  });
});
