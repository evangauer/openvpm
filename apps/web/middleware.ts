import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
} from "./lib/security-headers";
import { nextAuthSecret } from "./lib/auth-secret";

const PUBLIC_PATH_PREFIXES = [
  "/accept-invite",
  "/api",
  "/api-docs",
  "/book",
  "/capture",
  "/clinic-fit",
  "/email-preferences",
  "/forgot-password",
  "/help",
  "/legal",
  "/login",
  "/pay",
  "/portal",
  "/register",
  "/reset-password",
  "/sign",
  "/sms",
  "/staff-copilot-demo",
  "/verify-email",
];

const PUBLIC_FILE_PATTERN =
  /\.(?:avif|css|gif|ico|jpg|jpeg|js|json|map|png|svg|txt|webp|xml)$/i;

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_FILE_PATTERN.test(pathname) ||
    PUBLIC_PATH_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  );
}

function isVercelObservabilityPath(pathname: string): boolean {
  if (pathname.startsWith("/_vercel/insights/")) return true;

  // Vercel may proxy Web Analytics through a deployment-specific base path,
  // e.g. /5691167a7e0cfa40/view or /5691167a7e0cfa40/event.
  return /^\/[a-f0-9]{16}\/(?:script\.js|view|event|session)$/i.test(pathname);
}

function requestNonce(): string {
  return btoa(crypto.randomUUID());
}

function nextWithNonce(request: NextRequest, nonce: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads the request-side CSP while rendering and extracts this nonce
  // for framework, page, and inline bootstrap scripts. The same policy is set
  // on the response by applySecurityHeaders below.
  requestHeaders.set(
    "Content-Security-Policy",
    buildContentSecurityPolicy(nonce),
  );
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export async function middleware(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;
  const nonce = requestNonce();

  if (isVercelObservabilityPath(pathname)) {
    return applySecurityHeaders(nextWithNonce(request, nonce), { nonce });
  }

  if (isPublicPath(pathname)) {
    return applySecurityHeaders(nextWithNonce(request, nonce), { nonce });
  }

  const secret = nextAuthSecret();
  const token = secret ? await getToken({ req: request, secret }) : null;

  // Unauthenticated visitors go to the demo login, which offers one-click
  // demo access. (Previously the root path bounced to the marketing site,
  // which dead-ended anyone who came straight to demo.openvpm.com to try it.)
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    const nextPath = `${pathname}${requestUrl.search}`;
    if (nextPath !== "/") {
      loginUrl.searchParams.set("next", nextPath);
    }
    return applySecurityHeaders(NextResponse.redirect(loginUrl), { nonce });
  }

  const response = nextWithNonce(request, nonce);
  return applySecurityHeaders(response, { nonce });
}

export const config = {
  matcher: ["/((?!_next).*)"],
};
