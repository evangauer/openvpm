import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { withSystem } from "@/lib/tenant-db";
import { insertFunnelEvent } from "@/lib/funnel-events-server";
import { rateLimit, rateLimitResponseHeaders } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  jsonRequestContentLengthTooLarge,
  readJsonRequestBody,
} from "@/lib/request-json";

const EVENT_LIMIT = 120;
const EVENT_WINDOW_MS = 5 * 60 * 1000;
const ALLOWED_ORIGINS = new Set([
  "https://openvpm.com",
  "https://www.openvpm.com",
  "https://demo.openvpm.com",
  "https://app.openvpm.com",
  "http://localhost:3000",
]);
const ALLOWED_PROP_KEYS = new Set([
  "campaign",
  "intent",
  "placement",
  "role",
  "tool",
  "model",
  "goal",
  "step",
]);
const ALLOWED_CLINIC_MODELS = new Set([
  "companion",
  "mobile",
  "equine",
  "specialty",
  "shelter",
  "exploring",
]);
const ALLOWED_FIRST_GOALS = new Set([
  "run_visit",
  "import_records",
  "start_fresh",
  "explore_sample",
  "self_host",
]);
const ALLOWED_ONBOARDING_STEPS = new Set([
  "profile",
  "account",
  "workspace",
  "intent",
  "basics",
  "data",
  "allSet",
  "first_action",
]);
const UUID_PATH_SEGMENT_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

const eventSchema = z
  .object({
    eventId: z.string().uuid(),
    anonymousId: z.string().uuid(),
    name: z.enum([
      "visit",
      "demo_land",
      "demo_gate_viewed",
      "demo_gate_submitted",
      "demo_role_selected",
      "demo_tool_opened",
      "demo_cta_start_clinic",
      "signup_land",
      "signup_profile_viewed",
      "signup_profile_completed",
      "signup_account_viewed",
      "signup_submitted",
      "signup_succeeded",
      "onboarding_model_selected",
      "onboarding_goal_selected",
      "onboarding_plan_built",
      "onboarding_step_viewed",
      "onboarding_step_completed",
      "onboarding_completed",
      "first_action_selected",
    ]),
    source: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9._:/-]+$/)
      .optional(),
    path: z.string().trim().min(1).max(500).startsWith("/").optional(),
    props: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();

function allowedOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(
  request: Request,
  body: Record<string, unknown>,
  init?: ResponseInit,
) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...corsHeaders(allowedOrigin(request)),
      ...init?.headers,
    },
  });
}

function cleanProps(
  props: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  if (!props) return {};
  const entries = Object.entries(props)
    .filter(([key, value]) => {
      if (!ALLOWED_PROP_KEYS.has(key)) return false;
      if (key === "model") {
        return typeof value === "string" && ALLOWED_CLINIC_MODELS.has(value);
      }
      if (key === "goal") {
        return typeof value === "string" && ALLOWED_FIRST_GOALS.has(value);
      }
      if (key === "step") {
        return typeof value === "string" && ALLOWED_ONBOARDING_STEPS.has(value);
      }
      return typeof value !== "string" || value.length <= 200;
    })
    .slice(0, 20);
  return Object.fromEntries(entries);
}

function cleanPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.split(/[?#]/, 1)[0]!.replace(UUID_PATH_SEGMENT_RE, ":id");
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(request: Request) {
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin && !ALLOWED_ORIGINS.has(requestOrigin)) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  if (jsonRequestContentLengthTooLarge(request.headers)) {
    return json(request, { ok: false }, { status: 413 });
  }

  let limit;
  try {
    limit = await rateLimit({
      key: `funnel-event:ip:${clientIpFromRequest(request)}`,
      limit: EVENT_LIMIT,
      windowMs: EVENT_WINDOW_MS,
    });
  } catch (error) {
    console.error("[funnel-event] rate limit failed:", error);
    return json(request, { ok: false }, { status: 429 });
  }
  if (!limit.success) {
    return json(
      request,
      { ok: false },
      {
        status: 429,
        headers: rateLimitResponseHeaders(EVENT_LIMIT, limit),
      },
    );
  }

  const body = await readJsonRequestBody(request);
  if (!body.ok) {
    return json(
      request,
      { ok: false },
      { status: body.reason === "too_large" ? 413 : 400 },
    );
  }
  const parsed = eventSchema.safeParse(body.data);
  if (!parsed.success) {
    return json(request, { ok: false }, { status: 400 });
  }

  try {
    await withSystem(db, (tx) =>
      insertFunnelEvent(tx, {
        id: parsed.data.eventId,
        eventName: parsed.data.name,
        anonymousId: parsed.data.anonymousId,
        source: parsed.data.source,
        path: cleanPath(parsed.data.path),
        origin: requestOrigin,
        metadata: cleanProps(parsed.data.props),
      }),
    );
    return json(request, { ok: true }, { status: 202 });
  } catch (error) {
    console.error("[funnel-event] insert failed:", error);
    return json(request, { ok: false }, { status: 500 });
  }
}
