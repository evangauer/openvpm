import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveTreatmentPlanConsentToken } from "@/lib/consult/tokens";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8",
);

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(async () => result),
      limit: vi.fn(async () => result),
    };
    return builder;
  });
  const tx = { select };
  return {
    tx,
    selectResults,
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    ),
    withTenant: vi.fn(),
    lockPracticeForExternalSideEffects: vi.fn(async () => true),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 10,
      resetAt: new Date("2099-01-01T00:00:00Z"),
    })),
  };
});

vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
  withTenant: mocks.withTenant,
}));
vi.mock("@/lib/recovery-hold", () => ({
  lockPracticeForExternalSideEffects: mocks.lockPracticeForExternalSideEffects,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    rateLimit: mocks.rateLimit,
    rateLimitResponseHeaders: actual.rateLimitResponseHeaders,
  };
});
vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: () => false,
  hasHostedFullAccess: () => true,
}));
vi.mock("@/lib/app-url", () => ({ appBaseUrl: () => "https://openvpm.test" }));
vi.mock("@/lib/treatment-plan-presentations/policy", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/treatment-plan-presentations/policy")
    >();
  return { ...actual, treatmentPlanClientDecisionsEnabled: () => true };
});

const { GET, POST } = await import("./route");
const TOKEN = "ab".repeat(32);
const line = {
  id: "00000000-0000-0000-0000-000000000010",
  sortOrder: 0,
  description: "Blood work",
  offeredQuantity: "1.000",
  unitPrice: "50.00",
  lineSubtotal: "50.00",
  taxAmount: "0.00",
  lineTotal: "50.00",
};

function session(status: "pending" | "awaiting_signature" | "completed") {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    practiceId: "00000000-0000-0000-0000-000000000002",
    planId: "00000000-0000-0000-0000-000000000003",
    revisionId: "00000000-0000-0000-0000-000000000004",
    responseId: "00000000-0000-0000-0000-000000000005",
    createdBy: "00000000-0000-0000-0000-000000000006",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    status,
    decisions: status === "pending" ? null : [],
    responseSha256: status === "pending" ? null : "a".repeat(64),
    consentRequestId:
      status === "pending" ? null : "00000000-0000-0000-0000-000000000007",
    title: "Peanut plan",
    planStatus: status === "completed" ? "completed" : "open",
    patientId: "00000000-0000-0000-0000-000000000008",
    appointmentId: null,
    patientName: "Peanut",
    revisionNumber: 2,
    currency: "USD",
    subtotal: "50.00",
    tax: "0.00",
    total: "50.00",
    tier: "free",
    billingStatus: "trialing",
    trialEndsAt: new Date("2099-01-01T00:00:00Z"),
  };
}

function callGet(token = TOKEN) {
  return GET(
    new Request(`https://openvpm.test/api/treatment-plan/${token}`) as never,
    { params: Promise.resolve({ token }) },
  );
}

function callPost(body: unknown) {
  return POST(
    new Request(`https://openvpm.test/api/treatment-plan/${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ token: TOKEN }) },
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.lockPracticeForExternalSideEffects.mockResolvedValue(true);
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 10,
    resetAt: new Date("2099-01-01T00:00:00Z"),
  });
});

describe("public treatment-plan capability route", () => {
  it("returns a generic no-store miss for malformed capabilities", async () => {
    const malformed = await callGet("short");
    expect(malformed.status).toBe(404);
    expect(malformed.headers.get("Cache-Control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(mocks.withSystem).not.toHaveBeenCalled();
  });

  it("returns a generic miss when the database excludes an expired capability", async () => {
    mocks.selectResults.push([]);
    const response = await callGet();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
  });

  it("returns a generic miss when a capability points at stale plan state", async () => {
    mocks.selectResults.push([
      { ...session("pending"), planStatus: "completed" },
    ]);
    const response = await callGet();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
  });

  it("returns only the exact priced revision while pending", async () => {
    mocks.selectResults.push([session("pending")], [line]);
    const response = await callGet();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "pending",
      revisionNumber: 2,
      total: "50.00",
      lines: [line],
    });
  });

  it("keeps completed capabilities terminal and idempotent", async () => {
    mocks.selectResults.push([session("completed")], [line]);
    const getResponse = await callGet();
    await expect(getResponse.json()).resolves.toEqual({
      status: "completed",
      signUrl: null,
    });

    mocks.selectResults.push([session("completed")], [line]);
    const postResponse = await callPost({
      decisions: [
        {
          revisionLineId: line.id,
          decision: "accepted",
          acceptedQuantity: "1",
        },
      ],
    });
    expect(postResponse.status).toBe(200);
    await expect(postResponse.json()).resolves.toEqual({
      status: "completed",
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("returns the existing sign link for an exact retry after JSONB key reordering", async () => {
    mocks.selectResults.push(
      [
        {
          ...session("awaiting_signature"),
          decisions: [
            {
              decision: "accepted",
              declineReason: null,
              revisionLineId: line.id,
              acceptedQuantity: "1.000",
            },
          ],
        },
      ],
      [line],
      [{ id: "00000000-0000-0000-0000-000000000007" }],
    );
    const response = await callPost({
      decisions: [
        {
          revisionLineId: line.id,
          decision: "accepted",
          acceptedQuantity: "1",
        },
      ],
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "awaiting_signature",
      signUrl: `https://openvpm.test/sign/${deriveTreatmentPlanConsentToken(TOKEN)}`,
    });
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it("contains explicit database predicates for expiry, latest revision, and state pairing", () => {
    expect(ROUTE_SOURCE).toContain(
      "gt(visitTreatmentPlanPresentations.expiresAt, new Date())",
    );
    expect(ROUTE_SOURCE).toContain("not exists (");
    expect(ROUTE_SOURCE).toContain("newer.revision_number >");
    expect(ROUTE_SOURCE).toContain(
      'session.status === "completed" && session.planStatus !== "completed"',
    );
    expect(ROUTE_SOURCE).toContain(
      'session.status !== "completed" && session.planStatus !== "open"',
    );
    expect(ROUTE_SOURCE).toContain("deriveTreatmentPlanConsentToken(token)");
    expect(ROUTE_SOURCE).toContain("token: null");
    expect(ROUTE_SOURCE).toContain("tokenHash: consentTokenHash");
    expect(ROUTE_SOURCE).toContain("formId: form.id");
    expect(ROUTE_SOURCE).not.toContain("formId: null");
    const postSource = ROUTE_SOURCE.slice(
      ROUTE_SOURCE.indexOf("async function handlePost("),
      ROUTE_SOURCE.indexOf("export async function GET("),
    );
    expect(postSource.indexOf("enforceRateLimits(")).toBeLessThan(
      postSource.indexOf("withSystem("),
    );
  });
});
