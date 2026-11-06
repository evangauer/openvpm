import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import { readBuildProgress, verifyBuildResumeToken } from "@/lib/build/progress";
import { withSystem } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";

/** Returns the saved build behind a resume link from email. */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  const verified = verifyBuildResumeToken(token);
  if (!verified) {
    return NextResponse.json({ error: "Link expired" }, { status: 404 });
  }
  const progress = await withSystem(db, (tx) =>
    readBuildProgress(tx, verified.leadId),
  );
  if (!progress) {
    return NextResponse.json({ error: "Nothing saved" }, { status: 404 });
  }
  return NextResponse.json(
    { state: progress.state, scene: progress.scene },
    { headers: { "Cache-Control": "no-store" } },
  );
}
