import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openpims/db/client";
import { rowsFromExecute } from "@/lib/db/execute-rows";
import {
  isNpsScore,
  npsCategory,
  NPS_COMMENT_MAX_LENGTH,
} from "@/lib/growth/customer-lifecycle";
import { notifyLeadHandRaise } from "@/lib/growth/lead-alerts";
import { verifyNpsToken } from "@/lib/growth/nps-token";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

const NPS_BODY_MAX_BYTES = 4 * 1024;

function pageUrl(request: Request, params: Record<string, string>): URL {
  const url = new URL("/feedback/nps", request.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Records one clinic's answer to one NPS survey. Answering again from the
 * same email updates the answer. Detractors and comments alert the team so a
 * person follows up while it still matters.
 */
export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > NPS_BODY_MAX_BYTES) {
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const token = String(form.get("token") ?? "");
  const rawScore = String(form.get("score") ?? "");
  const score = /^\d{1,2}$/.test(rawScore) ? Number(rawScore) : NaN;
  const comment =
    String(form.get("comment") ?? "")
      .trim()
      .slice(0, NPS_COMMENT_MAX_LENGTH) || null;

  const verified = verifyNpsToken(token);
  if (!verified) {
    return NextResponse.redirect(pageUrl(request, { token: "" }), 303);
  }
  if (!isNpsScore(score)) {
    return NextResponse.redirect(pageUrl(request, { token }), 303);
  }

  const result = await withSystem(db, (tx) =>
    tx.execute(sql`
      with practice as (
        select id, name from practices
        where id = ${verified.practiceId}::uuid and deleted_at is null
      ), saved as (
        insert into practice_nps_responses (practice_id, survey, score, comment)
        select id, ${verified.survey}, ${score}, ${comment} from practice
        on conflict (practice_id, survey) do update set
          score = excluded.score,
          comment = coalesce(excluded.comment, practice_nps_responses.comment),
          updated_at = now()
        returning practice_id
      )
      select practice.name from practice join saved on saved.practice_id = practice.id
    `),
  );
  const practice = rowsFromExecute<{ name: string }>(result)[0];
  if (!practice) {
    return NextResponse.redirect(pageUrl(request, { token: "" }), 303);
  }

  const category = npsCategory(score);
  if (category === "detractor" || comment) {
    await notifyLeadHandRaise({
      practiceId: verified.practiceId,
      practiceName: practice.name,
      summary: `NPS ${score} (${category})`,
      note: comment,
    });
  }

  return NextResponse.redirect(
    pageUrl(request, { token, saved: String(score) }),
    303,
  );
}
