import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { nextAuthSecret } from "@/lib/auth-secret";

export const INVOICE_PAYMENT_TOKEN_MAX_LENGTH = 512;
export const INVOICE_PAYMENT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = "v1";
const TOKEN_PURPOSE = "openvpm:invoice-payment";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InvoicePaymentTokenPayload = {
  invoiceId: string;
  clientId: string;
  practiceId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

function signingSecret(): string {
  const secret = nextAuthSecret();
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET is required for invoice payment links");
  }
  return secret;
}

function signature(encodedPayload: string): Buffer {
  return createHmac("sha256", signingSecret())
    .update(`${TOKEN_PURPOSE}:${TOKEN_VERSION}.${encodedPayload}`)
    .digest();
}

function isValidPayload(
  value: unknown,
  nowSeconds: number,
): value is InvoicePaymentTokenPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<InvoicePaymentTokenPayload>;
  if (
    typeof payload.invoiceId !== "string" ||
    typeof payload.clientId !== "string" ||
    typeof payload.practiceId !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number" ||
    typeof payload.nonce !== "string"
  ) {
    return false;
  }
  if (
    !UUID_PATTERN.test(payload.invoiceId) ||
    !UUID_PATTERN.test(payload.clientId) ||
    !UUID_PATTERN.test(payload.practiceId) ||
    !/^[0-9a-f]{24}$/i.test(payload.nonce)
  ) {
    return false;
  }
  const maxTtlSeconds = Math.floor(INVOICE_PAYMENT_TOKEN_TTL_MS / 1000);
  return (
    Number.isInteger(payload.issuedAt) &&
    Number.isInteger(payload.expiresAt) &&
    payload.issuedAt <= nowSeconds + 5 * 60 &&
    payload.expiresAt > nowSeconds &&
    payload.expiresAt - payload.issuedAt > 0 &&
    payload.expiresAt - payload.issuedAt <= maxTtlSeconds
  );
}

export function createInvoicePaymentToken(input: {
  invoiceId: string;
  clientId: string;
  practiceId: string;
  now?: Date;
}): string {
  if (
    !UUID_PATTERN.test(input.invoiceId) ||
    !UUID_PATTERN.test(input.clientId) ||
    !UUID_PATTERN.test(input.practiceId)
  ) {
    throw new Error("Invoice payment token identifiers must be UUIDs");
  }
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const payload: InvoicePaymentTokenPayload = {
    invoiceId: input.invoiceId,
    clientId: input.clientId,
    practiceId: input.practiceId,
    issuedAt,
    expiresAt: issuedAt + Math.floor(INVOICE_PAYMENT_TOKEN_TTL_MS / 1000),
    nonce: randomBytes(12).toString("hex"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  return `${TOKEN_VERSION}.${encodedPayload}.${signature(encodedPayload).toString("base64url")}`;
}

export function verifyInvoicePaymentToken(
  token: string,
  options: { now?: Date } = {},
): InvoicePaymentTokenPayload | null {
  if (!token || token.length > INVOICE_PAYMENT_TOKEN_MAX_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  if (!encodedPayload || !encodedSignature) return null;

  let suppliedSignature: Buffer;
  let payload: unknown;
  try {
    suppliedSignature = Buffer.from(encodedSignature, "base64url");
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
  } catch {
    return null;
  }

  const expectedSignature = signature(encodedPayload);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    return null;
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  return isValidPayload(payload, nowSeconds) ? payload : null;
}
