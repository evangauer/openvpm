import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("./route.ts", import.meta.url)),
  "utf8"
);

const mocks = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => result),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });
  const db = { select };

  return {
    db,
    selectResults,
    createCheckoutSession: vi.fn(async () => ({
      url: "https://stripe.example/portal-checkout",
    })),
    withSystem: vi.fn(async (_db: unknown, fn: (tx: unknown) => unknown) =>
      fn(db)
    ),
    billingEnforced: vi.fn(() => false),
    hasHostedFullAccess: vi.fn(() => true),
    rateLimit: vi.fn(async () => ({
      success: true,
      remaining: 9,
      resetAt: new Date("2026-06-27T12:00:00Z"),
    })),
    rateLimitResponseHeaders: vi.fn(
      (
        limit: number,
        result: { remaining: number; resetAt: Date }
      ): Record<string, string> => ({
        "Retry-After": String(
          Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000))
        ),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": result.resetAt.toISOString(),
      })
    ),
  };
});

vi.mock("@openpims/db/client", () => ({
  db: mocks.db,
}));

vi.mock("@/lib/tenant-db", () => ({
  withSystem: mocks.withSystem,
}));

vi.mock("@/lib/stripe", () => ({
  createCheckoutSession: mocks.createCheckoutSession,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: mocks.billingEnforced,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
  rateLimitResponseHeaders: mocks.rateLimitResponseHeaders,
}));

const { POST } = await import("./route");
const { JSON_REQUEST_BODY_MAX_BYTES } = await import("@/lib/request-json");

const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";
const INVOICE_ID = "00000000-0000-0000-0000-0000000000cc";
const PATIENT_ID = "00000000-0000-0000-0000-0000000000dd";
const IP = "203.0.113.10";
const TOKEN_BUCKET =
  "portal-checkout:token:0ba11c8c03cc892e40cac090ac14c4db6e655ecfaff2490257fbe4c10fba19f9";

function portalRawRequest(body: string, headers?: HeadersInit) {
  const request = new Request(
    "https://portal.example.com/api/portal/checkout",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body,
    }
  );
  Object.defineProperty(request, "nextUrl", {
    value: new URL("https://portal.example.com/api/portal/checkout"),
  });
  return request as never;
}

function portalRequest(body: unknown, headers?: HeadersInit) {
  return portalRawRequest(JSON.stringify(body), headers);
}

function invalidJsonRequest() {
  return portalRawRequest("{nope");
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_ID,
    practiceId: PRACTICE_ID,
    firstName: "Jane",
    lastName: "Client",
    email: "jane@example.com",
    ...overrides,
  };
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    total: "100.00",
    paidAmount: "25.00",
    status: "sent",
    isEstimate: false,
    clientId: CLIENT_ID,
    patientId: PATIENT_ID,
    practiceId: PRACTICE_ID,
    ...overrides,
  };
}

function practice(overrides: Record<string, unknown> = {}) {
  return {
    currency: "usd",
    tier: "free",
    billingStatus: "none",
    trialEndsAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.selectResults.length = 0;
  mocks.createCheckoutSession.mockResolvedValue({
    url: "https://stripe.example/portal-checkout",
  });
  mocks.billingEnforced.mockReturnValue(false);
  mocks.hasHostedFullAccess.mockReturnValue(true);
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 9,
    resetAt: new Date("2026-06-27T12:00:00Z"),
  });
});

describe("portal checkout route", () => {
  it.each([
    { payload: {}, label: "missing fields" },
    {
      payload: { token: "portal-token", invoiceId: "not-a-uuid" },
      label: "invalid invoice id",
    },
    {
      payload: { token: "   ", invoiceId: INVOICE_ID },
      label: "blank token",
    },
    {
      payload: { token: "a".repeat(65), invoiceId: INVOICE_ID },
      label: "oversized token",
    },
  ])("rejects $label before entering system context", async ({ payload }) => {
    const response = await POST(portalRequest(payload));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid token or invoiceId",
    });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before entering system context", async () => {
    const response = await POST(invalidJsonRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
    });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON bodies before rate limits or system context", async () => {
    const response = await POST(
      portalRawRequest("{}", {
        "content-length": String(JSON_REQUEST_BODY_MAX_BYTES + 1),
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Request body too large",
    });
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rate-limits unresolved-IP portal checkout probes before token or Stripe work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:45:00Z"));
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-06-27T13:00:00Z"),
    });

    const response = await POST(
      portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("900");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBe(
      "2026-06-27T13:00:00.000Z"
    );
    await expect(response.json()).resolves.toEqual({
      error:
        "Too many payment attempts. Please try again later or call the clinic.",
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: "portal-checkout:ip:unknown",
      limit: 30,
      windowMs: 15 * 60 * 1000,
    });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("fails closed when the portal checkout IP limiter is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:45:00Z"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit.mockRejectedValueOnce(new Error("rate limiter down"));

    try {
      const response = await POST(
        portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("900");
      expect(response.headers.get("X-RateLimit-Limit")).toBe("30");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response.headers.get("X-RateLimit-Reset")).toBe(
        "2026-06-27T13:00:00.000Z"
      );
      await expect(response.json()).resolves.toEqual({
        error:
          "Too many payment attempts. Please try again later or call the clinic.",
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[portal-checkout] rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.rateLimit).toHaveBeenCalledWith({
        key: "portal-checkout:ip:unknown",
        limit: 30,
        windowMs: 15 * 60 * 1000,
      });
      expect(mocks.withSystem).not.toHaveBeenCalled();
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rate-limits portal checkout tokens after unresolved-IP fallback passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:45:00Z"));
    mocks.rateLimit
      .mockResolvedValueOnce({
        success: true,
        remaining: 29,
        resetAt: new Date("2026-06-27T12:15:00Z"),
      })
      .mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: new Date("2026-06-27T13:00:00Z"),
      });

    const response = await POST(
      portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("900");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBe(
      "2026-06-27T13:00:00.000Z"
    );
    await expect(response.json()).resolves.toEqual({
      error:
        "Too many payment attempts. Please try again later or call the clinic.",
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
      key: "portal-checkout:ip:unknown",
      limit: 30,
      windowMs: 15 * 60 * 1000,
    });
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
      key: TOKEN_BUCKET,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    expect(mocks.rateLimit).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "portal-checkout:portal-token" })
    );
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("fails closed when the portal checkout token limiter is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:45:00Z"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.rateLimit
      .mockResolvedValueOnce({
        success: true,
        remaining: 29,
        resetAt: new Date("2026-06-27T12:15:00Z"),
      })
      .mockRejectedValueOnce(new Error("rate limiter down"));

    try {
      const response = await POST(
        portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("3600");
      expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response.headers.get("X-RateLimit-Reset")).toBe(
        "2026-06-27T13:45:00.000Z"
      );
      await expect(response.json()).resolves.toEqual({
        error:
          "Too many payment attempts. Please try again later or call the clinic.",
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[portal-checkout] rate limit failed:",
        expect.any(Error)
      );
      expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
        key: "portal-checkout:ip:unknown",
        limit: 30,
        windowMs: 15 * 60 * 1000,
      });
      expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
        key: TOKEN_BUCKET,
        limit: 10,
        windowMs: 60 * 60 * 1000,
      });
      expect(mocks.withSystem).not.toHaveBeenCalled();
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rate-limits portal checkout token probes by IP before token or Stripe work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:15Z"));
    mocks.rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      resetAt: new Date("2026-06-27T12:15:00Z"),
    });

    const response = await POST(
      portalRequest(
        { token: "portal-token", invoiceId: INVOICE_ID },
        { "x-forwarded-for": `${IP}, 198.51.100.5` }
      )
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("885");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("X-RateLimit-Reset")).toBe(
      "2026-06-27T12:15:00.000Z"
    );
    await expect(response.json()).resolves.toEqual({
      error:
        "Too many payment attempts. Please try again later or call the clinic.",
    });
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: `portal-checkout:ip:${IP}`,
      limit: 30,
      windowMs: 15 * 60 * 1000,
    });
    expect(mocks.withSystem).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("creates Stripe Checkout for the adjusted portal invoice balance", async () => {
    mocks.selectResults.push(
      [client()],
      [invoice()],
      [{ amount: "10.00" }],
      [{ name: "Biscuit" }],
      [practice({ currency: "cad" })]
    );

    const response = await POST(
      portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://stripe.example/portal-checkout",
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith({
      key: TOKEN_BUCKET,
      limit: 10,
      windowMs: 60 * 60 * 1000,
    });
    expect(mocks.rateLimit).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: "portal-checkout:portal-token" })
    );
    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        invoiceId: INVOICE_ID,
        amount: 6500,
        clientEmail: "jane@example.com",
        clientName: "Jane Client",
        description: "Invoice payment for Biscuit",
        currency: "cad",
        successUrl:
          `https://portal.example.com/portal/portal-token/invoices?payment=success&invoice=${INVOICE_ID}`,
        cancelUrl:
          `https://portal.example.com/portal/portal-token/invoices?payment=cancelled&invoice=${INVOICE_ID}`,
      })
    );
  });

  it.each([
    { url: null, label: "missing" },
    { url: "http://checkout.stripe.com/c/pay_123", label: "non-HTTPS" },
    { url: "javascript:alert(1)", label: "script" },
    {
      url: "https://user:pass@checkout.stripe.com/c/pay_123",
      label: "credentialed",
    },
  ])(
    "fails closed when Stripe returns a $label portal checkout URL",
    async ({ url }) => {
      mocks.createCheckoutSession.mockResolvedValueOnce({ url } as never);
      mocks.selectResults.push(
        [client()],
        [invoice()],
        [],
        [{ name: "Biscuit" }],
        [practice()]
      );

      const response = await POST(
        portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Payment processing is not configured",
      });
    }
  );

  it("rejects checkout when the token practice is missing or deleted", async () => {
    mocks.selectResults.push(
      [client()],
      [invoice({ patientId: null })],
      [],
      []
    );

    const response = await POST(
      portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid portal link",
    });
    expect(mocks.billingEnforced).not.toHaveBeenCalled();
    expect(mocks.hasHostedFullAccess).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects draft invoices before creating checkout", async () => {
    mocks.selectResults.push([client()], [invoice({ status: "draft" })]);

    const response = await POST(
      portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invoice has not been sent yet",
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects non-payable invoice statuses before balance or Stripe work", async () => {
    mocks.selectResults.push([client()], [invoice({ status: "processing" })]);

    const response = await POST(
      portalRequest({ token: "portal-token", invoiceId: INVOICE_ID })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invoice is not ready for online payment",
    });
    expect(mocks.db.select).toHaveBeenCalledTimes(2);
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("keeps portal checkout status eligibility aligned with the portal invoice UI", () => {
    expect(ROUTE_SOURCE).toContain(
      'invoice.status !== "sent" && invoice.status !== "overdue"'
    );
  });

  it("keeps portal checkout patient descriptions scoped to the invoice tenant", () => {
    const patientDescriptionLookup = ROUTE_SOURCE.match(
      /select\(\{ name: patients\.name \}\)[\s\S]+?\.limit\(1\)/
    )?.[0];
    expect(patientDescriptionLookup).toContain(
      "eq(patients.id, invoice.patientId)"
    );
    expect(patientDescriptionLookup).toContain(
      "eq(patients.clientId, invoice.clientId)"
    );
    expect(patientDescriptionLookup).toContain(
      "eq(patients.practiceId, invoice.practiceId)"
    );
    expect(patientDescriptionLookup).toContain("isNull(patients.deletedAt)");
  });

  it("requires an active practice before portal checkout can use billing state", () => {
    const practiceLookup = ROUTE_SOURCE.match(
      /select\(\{\s*currency: practices\.currency,[\s\S]+?\.limit\(1\)/
    )?.[0];

    expect(practiceLookup).toContain("eq(practices.id, invoice.practiceId)");
    expect(practiceLookup).toContain("isNull(practices.deletedAt)");
    expect(ROUTE_SOURCE).toContain('if (!practice) {');
  });

  it("validates Stripe checkout URLs before returning them to portal clients", () => {
    expect(ROUTE_SOURCE).toContain("isSafePortalCheckoutRedirectUrl");
    expect(ROUTE_SOURCE).toContain(
      "if (!isSafePortalCheckoutRedirectUrl(result?.url))"
    );
    expect(ROUTE_SOURCE).not.toContain("if (!result?.url)");
  });

  it("keeps portal checkout adjustment totals scoped through the current client invoice", () => {
    const adjustmentLookup = ROUTE_SOURCE.match(
      /\.from\(invoiceAdjustments\)[\s\S]+?const adjustedCents/
    )?.[0];

    expect(adjustmentLookup).toContain(
      "eq(invoiceAdjustments.invoiceId, invoice.id)"
    );
    expect(adjustmentLookup).toContain(
      "where ${invoices.id} = ${invoiceAdjustments.invoiceId}"
    );
    expect(adjustmentLookup).toContain("and ${invoices.clientId} = ${client.id}");
    expect(adjustmentLookup).toContain(
      "and ${invoices.practiceId} = ${client.practiceId}"
    );
    expect(adjustmentLookup).toContain("and ${invoices.deletedAt} is null");
  });
});
