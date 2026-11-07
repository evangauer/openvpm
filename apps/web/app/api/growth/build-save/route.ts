import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { billingEnforced } from "@/lib/billing/plans";
import {
  BUILD_SAVE_DISCLOSURE_VERSION,
  BUILD_SCENES,
  buildSavedStateSchema,
} from "@/lib/build/catalog";
import { saveBuildProgress } from "@/lib/build/progress";
import { normalizeLeadEmail } from "@/lib/growth/leads";
import { rateLimit } from "@/lib/rate-limit";
import { clientIpFromRequest } from "@/lib/request-ip";
import {
  jsonRequestContentLengthTooLarge,
  readJsonRequestBody,
} from "@/lib/request-json";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

const SAVE_LIMIT_PER_IP = 30;
const SAVE_LIMIT_PER_EMAIL = 20;
const SAVE_WINDOW_MS = 60 * 60 * 1000;

const saveSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(255),
    anonymousId: z.string().guid().optional(),
    scene: z.enum(BUILD_SCENES),
    state: buildSavedStateSchema,
    disclosureVersion: z.literal(BUILD_SAVE_DISCLOSURE_VERSION),
  })
  .strict();

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

/**
 * Saves a "Build your clinic" draft under the email the person gave, so the
 * walkthrough can be resumed from a link and followed up once. Hosted only.
 */
export async function POST(request: Request) {
  if (!billingEnforced()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (jsonRequestContentLengthTooLarge(request.headers)) {
    return NextResponse.json({ error: "Too large" }, { status: 413 });
  }
  const body = await readJsonRequestBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const parsed = saveSchema.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const email = normalizeLeadEmail(parsed.data.email);

  try {
    for (const [key, limit] of [
      [`build-save:ip:${clientIpFromRequest(request)}`, SAVE_LIMIT_PER_IP],
      [`build-save:email:${email}`, SAVE_LIMIT_PER_EMAIL],
    ] as const) {
      const result = await rateLimit({ key, limit, windowMs: SAVE_WINDOW_MS });
      if (!result.success) {
        return NextResponse.json(
          { error: "Too many saves. Try again later." },
          { status: 429 },
        );
      }
    }
  } catch (error) {
    console.error("[build-save] rate limit unavailable:", error);
    return NextResponse.json({ error: "Try again later" }, { status: 503 });
  }

  try {
    const saved = await withSystem(db, (tx) =>
      saveBuildProgress(tx, {
        email,
        anonymousId: parsed.data.anonymousId ?? null,
        state: parsed.data.state,
        scene: parsed.data.scene,
        now: new Date(),
      }),
    );
    if (!saved) {
      return NextResponse.json({ error: "Try again later" }, { status: 503 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[build-save] save failed:", error);
    return NextResponse.json({ error: "Try again later" }, { status: 503 });
  }
}
