import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(async () => ({
    success: true,
    remaining: 119,
    resetAt: new Date("2026-07-01T12:15:00Z"),
  })),
  dispatchWebhookEvent: vi.fn(async () => undefined),
  hasHostedFullAccess: vi.fn(() => true),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}));

vi.mock("@/lib/webhook-dispatcher", () => ({
  dispatchWebhookEvent: mocks.dispatchWebhookEvent,
}));

vi.mock("@/lib/billing/plans", () => ({
  billingEnforced: () => false,
  hasHostedFullAccess: mocks.hasHostedFullAccess,
}));

const { portalRouter } = await import("../routers/portal");

const TOKEN = "portal-token";
const TOKEN_BUCKET =
  "portal-read:token:0ba11c8c03cc892e40cac090ac14c4db6e655ecfaff2490257fbe4c10fba19f9";
const IP = "203.0.113.10";
const PRACTICE_ID = "00000000-0000-0000-0000-0000000000aa";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000bb";
const PATIENT_ID = "00000000-0000-0000-0000-000000000001";
const VACCINATION_RECORD_ID = "00000000-0000-0000-0000-000000000002";

function callerWithDb(db: Record<string, unknown>, ip?: string) {
  return portalRouter.createCaller({
    db,
    ip,
    portalSessionId: TOKEN,
    portalClient: {
      id: CLIENT_ID,
      practiceId: PRACTICE_ID,
      firstName: "Portal",
      lastName: "Client",
      email: "portal@example.test",
      phone: null,
    },
  } as never);
}

function createDb() {
  const select = vi.fn(() => {
    const builder = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(async () => []),
      limit: vi.fn(async () => []),
      then: (
        resolve: (value: unknown[]) => unknown,
        reject?: (error: unknown) => unknown
      ) => Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  });
  const db: Record<string, unknown> = {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    execute: vi.fn(async () => undefined),
    select,
  };
  return { db, select };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue({
    success: true,
    remaining: 119,
    resetAt: new Date("2026-07-01T12:15:00Z"),
  });
});

describe("portal public read rate limits", () => {
  const readProcedures = [
    {
      label: "client summary",
      call: (caller: ReturnType<typeof callerWithDb>) =>
        caller.getClient({ token: TOKEN }),
    },
    {
      label: "pet detail",
      call: (caller: ReturnType<typeof callerWithDb>) =>
        caller.getPetDetail({ token: TOKEN, patientId: PATIENT_ID }),
    },
    {
      label: "vaccination certificate",
      call: (caller: ReturnType<typeof callerWithDb>) =>
        caller.getVaccinationCertificateData({
          token: TOKEN,
          patientId: PATIENT_ID,
          vaccinationRecordId: VACCINATION_RECORD_ID,
        }),
    },
    {
      label: "appointments",
      call: (caller: ReturnType<typeof callerWithDb>) =>
        caller.getAppointments({ token: TOKEN }),
    },
    {
      label: "invoices",
      call: (caller: ReturnType<typeof callerWithDb>) =>
        caller.getInvoices({ token: TOKEN }),
    },
    {
      label: "appointment types",
      call: (caller: ReturnType<typeof callerWithDb>) =>
        caller.getAppointmentTypes({ token: TOKEN }),
    },
  ];

  it.each(readProcedures)(
    "rate-limits $label unresolved-IP probes before token or DB work",
    async ({ call }) => {
      mocks.rateLimit.mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: new Date("2026-07-01T12:15:00Z"),
      });
      const { db, select } = createDb();

      await expect(call(callerWithDb(db))).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message:
          "Too many portal requests. Please try again later or call the clinic.",
      });

      expect(mocks.rateLimit).toHaveBeenCalledWith({
        key: "portal-read:ip:unknown",
        limit: 300,
        windowMs: 15 * 60 * 1000,
      });
      expect(select).not.toHaveBeenCalled();
    }
  );

  it.each(readProcedures)(
    "rate-limits $label token after unresolved-IP fallback passes",
    async ({ call }) => {
      mocks.rateLimit
        .mockResolvedValueOnce({
          success: true,
          remaining: 299,
          resetAt: new Date("2026-07-01T12:15:00Z"),
        })
        .mockResolvedValueOnce({
          success: false,
          remaining: 0,
          resetAt: new Date("2026-07-01T12:15:00Z"),
        });
      const { db, select } = createDb();

      await expect(call(callerWithDb(db))).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message:
          "Too many portal requests. Please try again later or call the clinic.",
      });

      expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, {
        key: "portal-read:ip:unknown",
        limit: 300,
        windowMs: 15 * 60 * 1000,
      });
      expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, {
        key: TOKEN_BUCKET,
        limit: 120,
        windowMs: 15 * 60 * 1000,
      });
      expect(mocks.rateLimit).not.toHaveBeenCalledWith(
        expect.objectContaining({ key: `portal-read:${TOKEN}` })
      );
      expect(select).not.toHaveBeenCalled();
    }
  );

  it.each(readProcedures)(
    "rate-limits $label token probes by IP before token or DB work",
    async ({ call }) => {
      mocks.rateLimit.mockResolvedValueOnce({
        success: false,
        remaining: 0,
        resetAt: new Date("2026-07-01T12:15:00Z"),
      });
      const { db, select } = createDb();

      await expect(call(callerWithDb(db, IP))).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message:
          "Too many portal requests. Please try again later or call the clinic.",
      });

      expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
      expect(mocks.rateLimit).toHaveBeenCalledWith({
        key: `portal-read:ip:${IP}`,
        limit: 300,
        windowMs: 15 * 60 * 1000,
      });
      expect(select).not.toHaveBeenCalled();
    }
  );

  it.each(readProcedures)(
    "fails closed for $label when the durable limiter is unavailable",
    async ({ call }) => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      mocks.rateLimit.mockRejectedValueOnce(new Error("rate limiter down"));
      const { db, select } = createDb();

      try {
        await expect(call(callerWithDb(db))).rejects.toMatchObject({
          code: "TOO_MANY_REQUESTS",
          message:
            "Too many portal requests. Please try again later or call the clinic.",
        });

        expect(consoleError).toHaveBeenCalledWith(
          "[portal] rate limit failed:",
          expect.any(Error)
        );
        expect(mocks.rateLimit).toHaveBeenCalledWith({
          key: "portal-read:ip:unknown",
          limit: 300,
          windowMs: 15 * 60 * 1000,
        });
        expect(select).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    }
  );
});
