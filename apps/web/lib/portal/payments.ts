import { isSafeCheckoutRedirectUrl } from "@/lib/checkout-redirect";

export type PortalPaymentStatus = "success" | "cancelled";

export interface PortalPaymentBanner {
  kind: "success" | "info";
  message: string;
}

const paymentSuccessMessage =
  "Payment received. Your invoice list will update once the payment is processed.";
const selectedInvoicePaymentSuccessMessage =
  "Payment received for the selected invoice. The balance will update once processing finishes.";

export function buildPortalPaymentReturnUrl(input: {
  origin: string;
  status: PortalPaymentStatus;
  invoiceId?: string;
}): string {
  const origin = input.origin.replace(/\/$/, "");
  const params = new URLSearchParams({ payment: input.status });
  if (input.invoiceId) {
    params.set("invoice", input.invoiceId);
  }
  return `${origin}/portal/invoices?${params.toString()}`;
}

export function buildInvoicePaymentReturnUrl(input: {
  origin: string;
  token: string;
  status: PortalPaymentStatus;
}): string {
  const origin = input.origin.replace(/\/$/, "");
  const params = new URLSearchParams({ payment: input.status });
  return `${origin}/pay/${encodeURIComponent(input.token)}?${params.toString()}`;
}

export function portalPaymentBanner(
  status: string | null,
  invoiceId?: string | null,
): PortalPaymentBanner | null {
  if (status === "success") {
    return {
      kind: "success",
      message: invoiceId
        ? selectedInvoicePaymentSuccessMessage
        : paymentSuccessMessage,
    };
  }
  if (status === "cancelled") {
    return {
      kind: "info",
      message: "Payment was canceled. No charge was made.",
    };
  }
  return null;
}

export function isSafePortalCheckoutRedirectUrl(
  value: unknown,
): value is string {
  return isSafeCheckoutRedirectUrl(value);
}
