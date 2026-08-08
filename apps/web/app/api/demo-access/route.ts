import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { demoAccesses } from "@openpims/db";
import {
  createDemoAccessToken,
  DEMO_ACCESS_COOKIE_NAME,
  DEMO_ACCESS_TTL_SECONDS,
  demoAccessEmailHash,
  demoModeEnabled,
  normalizeDemoAccessEmail,
} from "@/lib/demo-access";
import { AUTH_EMAIL_MAX_LENGTH } from "@/lib/auth-input-policy";
import { withSystem } from "@/lib/tenant-db";
import {
  rateLimit,
  rateLimitResponseHeaders,
  type RateLimitResult,
} from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import { readJsonRequestBody } from "@/lib/request-json";

const DEMO_ACCESS_BODY_MAX_BYTES = 2 * 1024;
const DEMO_ACCESS_WINDOW_MS = 60 * 60 * 1000;
const DEMO_ACCESS_IP_LIMIT = 12;
const DEMO_ACCESS_EMAIL_LIMIT = 5;

const demoAccessInput = z
  .object({
    email: z.string().trim().email().max(AUTH_EMAIL_MAX_LENGTH),
    // Optional by design: telemetry must never block immediate demo access.
    // The demo UI always supplies this first-party anonymous journey UUID.
    anonymousId: z.string().uuid().optional(),
  })
  .strict();

function funnelEventEndpoint(request: Request): URL {
  const configured = process.env.NEXT_PUBLIC_FUNNEL_ENDPOINT?.trim();
  if (configured) {
    try {
      return new URL("/api/funnel-event", configured);
    } catch {
      // Fall through to the hosted/local default.
    }
  }

  const requestUrl = new URL(request.url);
  const origin =
    requestUrl.hostname === "demo.openvpm.com"
      ? "https://app.openvpm.com"
      : requestUrl.origin;
  return new URL("/api/funnel-event", origin);
}

async function recordAcceptedDemoGate(
  request: Request,
  anonymousId: string,
): Promise<void> {
  const origin = new URL(request.url).origin;
  const response = await fetch(funnelEventEndpoint(request), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      eventId: randomUUID(),
      anonymousId,
      name: "demo_gate_submitted",
      source: "demo",
      path: "/login",
    }),
    signal: AbortSignal.timeout(750),
  });
  if (!response.ok) {
    throw new Error(`funnel endpoint returned ${response.status}`);
  }
}

function tooManyRequests(result: RateLimitResult, limit: number) {
  return NextResponse.json(
    { ok: false, error: "Please wait a little before trying again." },
    {
      status: 429,
      headers: rateLimitResponseHeaders(limit, result),
    },
  );
}

export async function POST(request: Request) {
  if (!demoModeEnabled()) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  const body = await readJsonRequestBody(request, DEMO_ACCESS_BODY_MAX_BYTES);
  if (!body.ok) {
    return NextResponse.json(
      { ok: false, error: "Add a valid work email." },
      { status: body.reason === "too_large" ? 413 : 400 },
    );
  }

  const parsed = demoAccessInput.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Add a valid work email." },
      { status: 400 },
    );
  }

  const email = normalizeDemoAccessEmail(parsed.data.email);
  const emailHash = demoAccessEmailHash(email);
  const ip = clientIpFromRequest(request);

  let ipLimit: RateLimitResult;
  let emailLimit: RateLimitResult;
  try {
    [ipLimit, emailLimit] = await Promise.all([
      rateLimit({
        key: `demo-access:ip:${ip}`,
        limit: DEMO_ACCESS_IP_LIMIT,
        windowMs: DEMO_ACCESS_WINDOW_MS,
      }),
      rateLimit({
        key: `demo-access:email:${emailHash}`,
        limit: DEMO_ACCESS_EMAIL_LIMIT,
        windowMs: DEMO_ACCESS_WINDOW_MS,
      }),
    ]);
  } catch (error) {
    console.error("[demo-access] rate limit failed:", error);
    return NextResponse.json(
      { ok: false, error: "The demo is temporarily unavailable." },
      { status: 503 },
    );
  }

  if (!ipLimit.success) return tooManyRequests(ipLimit, DEMO_ACCESS_IP_LIMIT);
  if (!emailLimit.success) {
    return tooManyRequests(emailLimit, DEMO_ACCESS_EMAIL_LIMIT);
  }

  const now = new Date();
  try {
    await withSystem(db, (tx) =>
      tx
        .insert(demoAccesses)
        .values({
          email,
          emailHash,
          firstAccessedAt: now,
          lastAccessedAt: now,
        })
        .onConflictDoUpdate({
          target: demoAccesses.email,
          set: {
            emailHash,
            lastAccessedAt: now,
            updatedAt: now,
            accessCount: sql`${demoAccesses.accessCount} + 1`,
          },
        }),
    );
  } catch (error) {
    console.error("[demo-access] capture failed:", error);
    return NextResponse.json(
      { ok: false, error: "The demo is temporarily unavailable." },
      { status: 503 },
    );
  }

  const token = createDemoAccessToken(email, { now });
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "The demo is temporarily unavailable." },
      { status: 503 },
    );
  }

  // Gate acceptance is a business event, so record it from the server after
  // the lead is durably captured. The demo uses a separate database, hence
  // the server-to-server write to app.openvpm.com. It remains non-blocking for
  // the visitor if telemetry is unavailable.
  if (parsed.data.anonymousId) {
    try {
      await recordAcceptedDemoGate(request, parsed.data.anonymousId);
    } catch (error) {
      console.error("[demo-access] funnel capture failed:", error);
    }
  }

  const response = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.cookies.set(DEMO_ACCESS_COOKIE_NAME, token, {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: DEMO_ACCESS_TTL_SECONDS,
  });
  return response;
}
