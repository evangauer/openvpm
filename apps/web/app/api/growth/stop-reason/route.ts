import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import {
  isStopReason,
  STOP_REASON_LABELS,
  STOP_REASON_NOTE_MAX_LENGTH,
} from "@/lib/growth/checkout-recovery";
import { notifyLeadHandRaise } from "@/lib/growth/lead-alerts";
import { verifyStopReasonToken } from "@/lib/growth/stop-reason-token";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

const STOP_REASON_BODY_MAX_BYTES = 4 * 1024;

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown[] } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function pageUrl(request: Request, params: Record<string, string>): URL {
  const url = new URL("/feedback/stop-reason", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Records why a registered clinic stopped before its trial. Saving a reason
 * ends the automated recovery emails (a person follows up instead) and alerts
 * the team, so the answer is never left unread.
 */
export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > STOP_REASON_BODY_MAX_BYTES) {
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const token = String(form.get("token") ?? "");
  const reason = String(form.get("reason") ?? "");
  const note =
    String(form.get("note") ?? "")
      .trim()
      .slice(0, STOP_REASON_NOTE_MAX_LENGTH) || null;

  const verified = verifyStopReasonToken(token);
  if (!verified) {
    return NextResponse.redirect(pageUrl(request, { token: "" }), 303);
  }
  if (!isStopReason(reason)) {
    return NextResponse.redirect(pageUrl(request, { token }), 303);
  }

  const answeredAt = new Date().toISOString();
  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      update practices
      set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb),
        '{growthLead}',
        coalesce(settings -> 'growthLead', '{}'::jsonb) || jsonb_build_object(
          'stopReason', ${reason}::text,
          'stopReasonNote', ${note}::text,
          'stopReasonAt', ${answeredAt}::text
        )
      )
      where id = ${verified.practiceId}::uuid
        and deleted_at is null
      returning name
    `),
  );
  const practice = rowsFromExecute<{ name: string }>(result)[0];
  if (!practice) {
    return NextResponse.redirect(pageUrl(request, { token: "" }), 303);
  }

  await notifyLeadHandRaise({
    practiceId: verified.practiceId,
    practiceName: practice.name,
    summary: `Stopped before trial: ${STOP_REASON_LABELS[reason]}`,
    note,
  });

  return NextResponse.redirect(pageUrl(request, { token, saved: reason }), 303);
}
