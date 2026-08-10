import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { captureException } from "@/lib/error-tracking";
import {
  CLIENT_ERROR_FAMILIES,
  CLIENT_ERROR_SOURCES,
  sanitizeClientErrorDigest,
  sanitizeClientErrorPath,
} from "@/lib/client-error-report";
import { insertFunnelEvent } from "@/lib/funnel-events-server";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  jsonRequestContentLengthTooLarge,
  readJsonRequestBody,
} from "@/lib/request-json";
import { withSystem } from "@/lib/tenant-db";

const ERROR_REPORT_LIMIT = 30;
const ERROR_REPORT_WINDOW_MS = 5 * 60 * 1000;
const errorReportSchema = z.object({
  source: z.enum(CLIENT_ERROR_SOURCES),
  errorFamily: z.enum(CLIENT_ERROR_FAMILIES).optional().default("Error"),
  digest: z.string().max(120).optional().nullable(),
  path: z.string().max(500).startsWith("/").optional().nullable(),
  anonymousId: z.string().uuid().optional().nullable(),
});

function errorReportRateLimitResponse(result: {
  remaining: number;
  resetAt: Date;
}) {
  return NextResponse.json(
    { ok: false },
    {
      status: 429,
      headers: rateLimitResponseHeaders(ERROR_REPORT_LIMIT, result),
    }
  );
}

async function enforceErrorReportRateLimit(ip: string) {
  try {
    const limit = await rateLimit({
      key: `error-report:ip:${ip}`,
      limit: ERROR_REPORT_LIMIT,
      windowMs: ERROR_REPORT_WINDOW_MS,
    });
    if (limit.success) return null;
    return errorReportRateLimitResponse(limit);
  } catch (err) {
    console.error("[error-report] rate limit failed:", err);
    return errorReportRateLimitResponse({
      remaining: 0,
      resetAt: new Date(Date.now() + ERROR_REPORT_WINDOW_MS),
    });
  }
}

export async function POST(request: Request) {
  if (jsonRequestContentLengthTooLarge(request.headers)) {
    return NextResponse.json({ ok: false }, { status: 413 });
  }

  const ip = clientIpFromRequest(request);
  const rateLimitResponse = await enforceErrorReportRateLimit(ip);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const json = await readJsonRequestBody(request);
  if (!json.ok) {
    return NextResponse.json(
      { ok: false },
      { status: json.reason === "too_large" ? 413 : 400 }
    );
  }

  const parsed = errorReportSchema.safeParse(json.data);
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const { anonymousId, source, errorFamily } = parsed.data;
  const digest = sanitizeClientErrorDigest(parsed.data.digest);
  const path = sanitizeClientErrorPath(parsed.data.path);
  await captureException({
    source,
    message: `${errorFamily} in client renderer`,
    stack: null,
    digest,
    path,
  });
  try {
    await withSystem(db, (tx) =>
      insertFunnelEvent(tx, {
        eventName: "client_error",
        anonymousId,
        source,
        path: path ?? undefined,
        metadata: {
          errorFamily,
          ...(digest ? { digest } : {}),
        },
      })
    );
  } catch (error) {
    // The primary error tracker remains authoritative. Operational counting
    // must not turn a successful report into another client-facing failure.
    console.error("[error-report] funnel event failed:", error);
  }
  return NextResponse.json({ ok: true });
}
