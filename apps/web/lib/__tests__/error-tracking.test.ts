import { describe, expect, it } from "vitest";
import { sanitizeErrorReport } from "../error-tracking";

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
