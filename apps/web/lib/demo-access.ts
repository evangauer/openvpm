import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { nextAuthSecret } from "@/lib/auth-secret";

export const DEMO_ACCESS_COOKIE_NAME = "openvpm_demo_access";
export const DEMO_ACCESS_TTL_SECONDS = 7 * 24 * 60 * 60;

export const DEMO_ROLE_EMAILS = {
  admin: "admin@neighborhoodvet.example.com",
  veterinarian: "sarah.chen@neighborhoodvet.example.com",
  technician: "jamie.torres@neighborhoodvet.example.com",
  front_desk: "morgan.bailey@neighborhoodvet.example.com",
} as const;

export type DemoRole = keyof typeof DEMO_ROLE_EMAILS;

type DemoAccessPayload = {
  v: 1;
  emailHash: string;
  iat: number;
  exp: number;
};

type TokenOptions = {
  now?: Date;
  secret?: string;
};

export function demoModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE?.trim() === "true";
}

export function normalizeDemoAccessEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function demoAccessEmailHash(email: string): string {
  return createHash("sha256")
    .update(normalizeDemoAccessEmail(email))
    .digest("hex");
}

export function isDemoRole(value: unknown): value is DemoRole {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(DEMO_ROLE_EMAILS, value)
  );
}

function tokenSecret(explicit?: string): string | null {
  const secret = explicit?.trim() || nextAuthSecret();
  return secret ?? null;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

export function createDemoAccessToken(
  email: string,
  options: TokenOptions = {}
): string | null {
  const secret = tokenSecret(options.secret);
  if (!secret) return null;

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload: DemoAccessPayload = {
    v: 1,
    emailHash: demoAccessEmailHash(email),
    iat: nowSeconds,
    exp: nowSeconds + DEMO_ACCESS_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyDemoAccessToken(
  token: string | null | undefined,
  options: TokenOptions = {}
): DemoAccessPayload | null {
  const secret = tokenSecret(options.secret);
  if (!secret || !token) return null;

  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;

  const expected = sign(encoded, secret);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Partial<DemoAccessPayload>;
    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
    const hashIsValid =
      typeof payload.emailHash === "string" &&
      /^[a-f0-9]{64}$/.test(payload.emailHash);
    const issuedAtIsValid =
      typeof payload.iat === "number" && payload.iat <= nowSeconds + 300;
    const expiryIsValid =
      typeof payload.exp === "number" && payload.exp > nowSeconds;

    if (
      payload.v !== 1 ||
      !hashIsValid ||
      !issuedAtIsValid ||
      !expiryIsValid
    ) {
      return null;
    }

    return payload as DemoAccessPayload;
  } catch {
    return null;
  }
}

function cookieHeader(headers: unknown): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get("cookie");
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record.cookie ?? record.Cookie;
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function demoAccessTokenFromRequest(request: unknown): string | null {
  const headers = (request as { headers?: unknown } | null)?.headers;
  const cookies = cookieHeader(headers);
  if (!cookies) return null;

  for (const part of cookies.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== DEMO_ACCESS_COOKIE_NAME) continue;
    const value = valueParts.join("=");
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export function verifiedDemoAccessFromRequest(
  request: unknown
): DemoAccessPayload | null {
  return verifyDemoAccessToken(demoAccessTokenFromRequest(request));
}
