import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const paymentPage = readFileSync("app/pay/[token]/page.tsx", "utf8");
const notificationRouter = readFileSync(
  "server/routers/notifications.ts",
  "utf8",
);

describe("invoice payment-only experience", () => {
  it("keeps the emailed link out of the full client portal", () => {
    expect(notificationRouter).toContain("createInvoicePaymentToken");
    expect(notificationRouter).toContain(
      "`/pay/${encodeURIComponent(paymentToken)}`",
    );
    expect(notificationRouter).not.toContain("ensureClientPortalAccessToken");
  });

  it("gives non-technical clients a clear, mobile-friendly payment page", () => {
    expect(paymentPage).toContain("No account or password required");
    expect(paymentPage).toContain("Pay securely online");
    expect(paymentPage).toContain("Secure checkout powered by Stripe");
    expect(paymentPage).toContain("min-h-12 w-full");
    expect(paymentPage).toContain("expires on");
  });
});
