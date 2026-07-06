import { NextResponse } from "next/server";
import { z } from "zod";
import { captureException } from "@/lib/error-tracking";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  jsonRequestContentLengthTooLarge,
  readJsonRequestBody,
} from "@/lib/request-json";

const ERROR_REPORT_LIMIT = 30;
const ERROR_REPORT_WINDOW_MS = 5 * 60 * 1000;

const errorReportSchema = z.object({
  source: z.string().min(1).max(80),
  message: z.string().min(1).max(1000),
  stack: z.string().max(5000).optional().nullable(),
  digest: z.string().max(200).optional().nullable(),
  path: z.string().max(500).optional().nullable(),
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

  await captureException(parsed.data);
  return NextResponse.json({ ok: true });
}
