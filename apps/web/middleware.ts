import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import {
  applyCapabilitySecurityHeaders,
  applySecurityHeaders,
} from "./lib/security-headers";
import {
  AUTH_SECRET_SETUP_COMMAND,
  authSecretProblemMessage,
  nextAuthSecret,
  nextAuthSecretProblem,
  nextAuthSecretRejected,
} from "./lib/auth-secret";
import { isSecretIndependentPath } from "./lib/secret-independent-paths";

const CAPABILITY_PATH_PREFIXES = [
  "/capture",
  "/sign",
  "/treatment-plan",
  "/api/capture",
  "/api/sign",
  "/api/treatment-plan",
];

const PUBLIC_PATH_PREFIXES = [
  "/accept-invite",
  "/api",
  "/api-docs",
  "/book",
  "/capture",
  "/clinic-fit",
  "/email-preferences",
  "/forgot-password",
  "/legal",
  "/login",
  "/portal",
  "/register",
  "/reset-password",
  "/sign",
  "/sms",
  "/treatment-plan",
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

function isCapabilityPath(pathname: string): boolean {
  return CAPABILITY_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isVercelObservabilityPath(pathname: string): boolean {
  if (pathname.startsWith("/_vercel/insights/")) return true;

  // Vercel may proxy Web Analytics through a deployment-specific base path,
  // e.g. /5691167a7e0cfa40/view or /5691167a7e0cfa40/event.
  return /^\/[a-f0-9]{16}\/(?:script\.js|view|event|session)$/i.test(pathname);
}

// Rendered straight from middleware so it never depends on a working session
// layer. It names the problem but never echoes the configured value.
function authSecretSetupResponse(pathname: string): NextResponse {
  const reason = authSecretProblemMessage(nextAuthSecretProblem() ?? "missing");

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return applySecurityHeaders(
      NextResponse.json(
        {
          error: "Authentication secret is not configured securely",
          detail: `${reason} Set a new NEXTAUTH_SECRET (${AUTH_SECRET_SETUP_COMMAND}) and restart OpenVPM.`,
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>OpenVPM setup required</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>Set NEXTAUTH_SECRET to finish setup</h1>
<p>${reason} Sign-in is disabled until this is fixed, because a known or weak secret would let anyone forge a staff session and read clinic records.</p>
<ol>
<li>Generate a secret: <code>${AUTH_SECRET_SETUP_COMMAND}</code></li>
<li>Set it as <code>NEXTAUTH_SECRET</code> in your <code>.env</code> file or deployment environment.</li>
<li>Restart OpenVPM. Everyone will need to sign in again once.</li>
</ol>
</body>
</html>`;
  return applySecurityHeaders(
    new NextResponse(html, {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }),
  );
}

export async function middleware(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const pathname = requestUrl.pathname;

  // Fail closed before any route can read or issue a session. Health stays
  // reachable so operators and orchestrators can see why the app is down.
  if (
    nextAuthSecretRejected() &&
    pathname !== "/api/health" &&
    !isSecretIndependentPath(pathname)
  ) {
    // Only root-level files (where public/ is served) skip the guard, so a
    // nested route ending in .json or .txt can't slip past it. /_next never
    // reaches middleware (see matcher).
    const isStaticAsset =
      PUBLIC_FILE_PATTERN.test(pathname) && !pathname.slice(1).includes("/");
    if (!isStaticAsset) return authSecretSetupResponse(pathname);
  }

  if (isVercelObservabilityPath(pathname)) {
    return applySecurityHeaders(NextResponse.next());
  }

  if (isCapabilityPath(pathname)) {
    return applyCapabilitySecurityHeaders(NextResponse.next());
  }

  if (isPublicPath(pathname)) {
    return applySecurityHeaders(NextResponse.next());
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
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  const response = NextResponse.next();
  return applySecurityHeaders(response);
}

export const config = {
  matcher: ["/((?!_next).*)"],
};
