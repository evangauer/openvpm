import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("portal invoices UI", () => {
  const source = readFileSync("app/portal/[token]/invoices/page.tsx", "utf8");
  const route = readFileSync("app/portal/invoices/page.tsx", "utf8");

  it("wraps query-string state in the Next.js suspense boundary", () => {
    expect(source).toContain("useSearchParams()");
    expect(route).toContain('import { Suspense } from "react"');
    expect(route).toContain("<Suspense");
    expect(route).toContain("<InvoicesPage />");
  });

  it("only exposes online payment actions for sent or overdue invoices", () => {
    expect(source).toContain(
      'inv.status === "sent" || inv.status === "overdue"',
    );
    expect(source).toContain(
      "const canPay = isPayable && inv.onlinePaymentsEnabled",
    );
    expect(source).not.toContain('inv.status !== "paid"');
    expect(source).not.toContain('inv.status !== "void"');
  });

  it("clearly gates payable invoices when online payments are unavailable", () => {
    expect(source).toContain("function PaymentUnavailable()");
    expect(source).toContain(
      "Online payment is temporarily unavailable. Please contact the clinic to",
    );
    expect(source).toContain("isPayable && !inv.onlinePaymentsEnabled");
  });

  it("makes the primary mobile payment action clear and easy to tap", () => {
    expect(source).toContain("Pay securely online");
    expect(source).toContain("Opening secure checkout...");
    expect(source).toContain("min-h-11 w-full");
    expect(source).toContain("Powered by Stripe");
    expect(source).toContain('role="alert"');
  });

  it("validates checkout redirects before leaving the portal", () => {
    expect(source).toContain("isSafePortalCheckoutRedirectUrl");
    expect(source).toContain(
      "if (!res.ok || !isSafePortalCheckoutRedirectUrl(data.url))",
    );
    expect(source).toContain("window.location.href = data.url");
    expect(source).not.toContain("if (!res.ok || !data.url)");
  });

  it("formats portal invoice dates through the portal date helper", () => {
    expect(source).toContain(
      'import { formatPortalDate } from "@/lib/portal/date"',
    );
    expect(source).toContain("return formatPortalDate(d, country, timeZone)");
    expect(source).toContain(
      "formatDate(inv.createdAt, inv.country, inv.timezone)",
    );
    expect(source).toContain(
      "formatDate(inv.dueDate, inv.country, inv.timezone)",
    );
    expect(source).not.toContain("new Date(d).toLocaleDateString");
  });

  it("highlights the invoice returned from Stripe checkout", () => {
    expect(source).toContain(
      'const returnedInvoiceId = searchParams.get("invoice")',
    );
    expect(source).toContain(
      'portalPaymentBanner(\n    searchParams.get("payment"),\n    returnedInvoiceId,\n  )',
    );
    expect(source).toContain(
      "const isReturnedInvoice = returnedInvoiceId === inv.id",
    );
    expect(source).toContain("border-primary/40 bg-primary/5");
    expect(source).toContain('isReturnedInvoice ? "bg-primary/5" : undefined');
  });
});
