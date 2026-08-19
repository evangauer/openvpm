import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInvoicePaymentToken,
  INVOICE_PAYMENT_TOKEN_TTL_MS,
  verifyInvoicePaymentToken,
} from "../invoice-payment-tokens";

const NOW = new Date("2026-08-17T16:00:00.000Z");
const IDS = {
  invoiceId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  practiceId: "33333333-3333-4333-8333-333333333333",
};

describe("invoice payment tokens", () => {
  const originalSecret = process.env.NEXTAUTH_SECRET;

  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret-at-least-32-characters-long");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalSecret === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = originalSecret;
  });

  it("issues a payment-only credential scoped to one invoice", () => {
    const token = createInvoicePaymentToken({ ...IDS, now: NOW });
    expect(token).not.toContain(IDS.invoiceId);
    expect(verifyInvoicePaymentToken(token, { now: NOW })).toMatchObject(IDS);
  });

  it("rejects tampering", () => {
    const token = createInvoicePaymentToken({ ...IDS, now: NOW });
    const payloadStart = token.indexOf(".") + 1;
    const tampered = `${token.slice(0, payloadStart)}${
      token[payloadStart] === "a" ? "b" : "a"
    }${token.slice(payloadStart + 1)}`;
    expect(verifyInvoicePaymentToken(tampered, { now: NOW })).toBeNull();
  });

  it("expires after thirty days", () => {
    const token = createInvoicePaymentToken({ ...IDS, now: NOW });
    expect(
      verifyInvoicePaymentToken(token, {
        now: new Date(NOW.getTime() + INVOICE_PAYMENT_TOKEN_TTL_MS),
      }),
    ).toBeNull();
  });

  it("requires the production authentication secret", () => {
    delete process.env.NEXTAUTH_SECRET;
    expect(() => createInvoicePaymentToken({ ...IDS, now: NOW })).toThrow(
      "NEXTAUTH_SECRET is required",
    );
  });
});
