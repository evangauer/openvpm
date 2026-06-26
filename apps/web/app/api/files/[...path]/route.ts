import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getObject } from "@/lib/s3";

export const dynamic = "force-dynamic";

/**
 * Same-origin file proxy. Uploaded objects live in a PRIVATE R2/S3 bucket, so
 * the raw storage URL can't be loaded by an <img> tag (it 401s). This streams
 * the object through the app instead.
 *
 * Access model, keyed off the object path `{practiceId}/{category}/{file}`:
 *  - `branding/*` (logos) is PUBLIC — logos must render in emails and the
 *    unauthenticated client portal, and contain nothing sensitive.
 *  - everything else (patient-photos, documents, lab-results) is tenant-private:
 *    the caller must be signed in and belong to the owning practice.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const key = params.path.map(decodeURIComponent).join("/");
  const [practiceId, category] = key.split("/");
  if (!practiceId || !category) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isPublic = category === "branding";
  if (!isPublic) {
    const session = await getServerSession(authOptions);
    if (!session?.user || session.user.practiceId !== practiceId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const obj = await getObject(key);
  if (!obj) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(Buffer.from(obj.body), {
    headers: {
      "Content-Type": obj.contentType ?? "application/octet-stream",
      "Cache-Control": isPublic
        ? "public, max-age=86400"
        : "private, max-age=3600",
    },
  });
}
