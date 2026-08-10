import { NextResponse } from "next/server";
import {
  emailPreferenceBaseUrl,
  verifyEmailPreferenceToken,
} from "@/lib/email-preferences";
import { setMarketingEmailPreferenceForHash } from "@/lib/platform-email-preferences";
import { readRequestTextWithLimit } from "@/lib/request-json";

export const dynamic = "force-dynamic";

const MAX_TOKEN_LENGTH = 4096;
const MAX_ONE_CLICK_BODY_BYTES = 128;

async function isValidOneClickRequest(request: Request): Promise<boolean> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return false;
  }

  const body = await readRequestTextWithLimit(
    request,
    MAX_ONE_CLICK_BODY_BYTES,
  );
  if (!body.ok) return false;
  const fields = new URLSearchParams(body.text);
  return fields.get("List-Unsubscribe") === "One-Click";
}

export async function POST(request: Request) {
  let canonicalOrigin: string | null = null;
  try {
    const canonicalBase = emailPreferenceBaseUrl();
    canonicalOrigin = canonicalBase ? new URL(canonicalBase).origin : null;
  } catch {
    // Missing or malformed deployment configuration is indistinguishable from
    // an invalid public link and must never become an unhandled 500.
  }
  if (!canonicalOrigin || new URL(request.url).origin !== canonicalOrigin) {
    return invalidLink();
  }

  if (!(await isValidOneClickRequest(request))) {
    return invalidLink();
  }

  const token = new URL(request.url).searchParams.get("token");
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return invalidLink();
  }

  const preference = verifyEmailPreferenceToken(token);
  if (!preference) return invalidLink();

  try {
    await setMarketingEmailPreferenceForHash({
      emailHash: preference.target.id,
      enabled: false,
      source: "unsubscribe_link",
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "We could not save that preference. Try again." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // A valid token always gets the same response. The hash-keyed upsert makes
  // the endpoint idempotent and lets a canonical hosted preference endpoint
  // carry a demo lead's choice into registration without storing the address.
  return NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function invalidLink() {
  return NextResponse.json(
    {
      ok: false,
      error: "This email preference link is invalid or unavailable.",
    },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
