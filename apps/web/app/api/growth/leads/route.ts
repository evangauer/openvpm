import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@openpims/db/client";
import { AUTH_EMAIL_MAX_LENGTH } from "@/lib/auth-input-policy";
import { isDemoDisclosureVersion } from "@/lib/growth/demo-disclosure";
import {
  leadCaptureAuthorized,
  leadCaptureSecret,
  upsertGrowthLead,
} from "@/lib/growth/leads";
import { readJsonRequestBody } from "@/lib/request-json";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

const LEAD_CAPTURE_BODY_MAX_BYTES = 2 * 1024;

const leadCaptureInput = z
  .object({
    source: z.literal("demo"),
    email: z.string().trim().email().max(AUTH_EMAIL_MAX_LENGTH),
    anonymousId: z.string().guid().optional(),
    disclosureVersion: z.string().refine(isDemoDisclosureVersion),
  })
  .strict();

/**
 * Server-to-server lead capture from the hosted demo deployment, which runs
 * on its own database. Authenticated with LEAD_CAPTURE_SECRET; disabled when
 * the secret is not configured.
 */
export async function POST(request: Request) {
  if (!leadCaptureSecret()) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
  if (!leadCaptureAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = await readJsonRequestBody(request, LEAD_CAPTURE_BODY_MAX_BYTES);
  if (!body.ok) {
    return NextResponse.json(
      { ok: false },
      { status: body.reason === "too_large" ? 413 : 400 },
    );
  }
  const parsed = leadCaptureInput.safeParse(body.data);
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  try {
    const lead = await withSystem(db, (tx) =>
      upsertGrowthLead(tx, {
        email: parsed.data.email,
        source: parsed.data.source,
        anonymousId: parsed.data.anonymousId ?? null,
        disclosureVersion: parsed.data.disclosureVersion as Parameters<
          typeof upsertGrowthLead
        >[1]["disclosureVersion"],
        now: new Date(),
      }),
    );
    return NextResponse.json({ ok: true, created: lead?.created ?? false });
  } catch (error) {
    console.error(
      "[growth-leads] capture failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
