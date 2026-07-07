import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  alertOps: vi.fn(async (_subject: string, _detail: string) => undefined),
}));

vi.mock("@/lib/alerts", () => ({
  alertOps: mocks.alertOps,
}));

const { captureTrpcError, sanitizeErrorReport } = await import(
  "../error-tracking"
);

afterEach(() => {
  vi.clearAllMocks();
});

describe("sanitizeErrorReport", () => {
  it("bounds every field before reporting", () => {
    const report = sanitizeErrorReport({
      source: "x".repeat(200),
      message: "m".repeat(1000),
      stack: "s".repeat(3000),
      digest: "d".repeat(300),
      path: Array.from({ length: 400 }, () => "p").join("/"),
    });

    expect(report.source).toHaveLength(80);
    expect(report.message).toHaveLength(500);
    expect(report.stack).toHaveLength(2000);
    expect(report.digest).toHaveLength(120);
    expect(report.path).toHaveLength(300);
  });

  it("strips query strings and redacts path tokens", () => {
    const report = sanitizeErrorReport({
      source: "app-error",
      message: "boom",
      path:
        "https://app.example.com/portal/tok_abcdefghijklmnopqrstuvwxyz1234567890/invoices/00000000-0000-4000-8000-000000000001?tab=billing#card",
    });

    expect(report.path).toBe("/portal/[token]/invoices/[id]");
  });
});

describe("captureTrpcError", () => {
  it("alerts on INTERNAL_SERVER_ERROR with the procedure path and cause stack", () => {
    const cause = new Error("db connection refused");
    captureTrpcError({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "boom",
        cause,
        stack: "trpc-wrapper-stack",
      },
      path: "patients.list",
      type: "query",
    });

    expect(mocks.alertOps).toHaveBeenCalledTimes(1);
    const [subject, detail] = mocks.alertOps.mock.calls[0];
    expect(subject).toBe("Unhandled app error (trpc)");
    expect(detail).toContain("message: query patients.list: boom");
    expect(detail).toContain("path: /api/trpc/patients.list");
    expect(detail).toContain("db connection refused");
  });

  it("ignores expected tRPC error codes", () => {
    for (const code of ["UNAUTHORIZED", "NOT_FOUND", "BAD_REQUEST"] as const) {
      captureTrpcError({
        error: { code, message: "expected", cause: undefined, stack: "s" },
        path: "patients.list",
        type: "query",
      });
    }

    expect(mocks.alertOps).not.toHaveBeenCalled();
  });
});
