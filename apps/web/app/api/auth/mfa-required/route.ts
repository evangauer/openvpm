import { NextResponse } from "next/server";
import { z } from "zod";
import { validCredentialsSecondFactor } from "@/lib/auth";
import { AUTH_PASSWORD_MAX_LENGTH } from "@/lib/auth-password";
import { AUTH_EMAIL_MAX_LENGTH } from "@/lib/auth-input-policy";
import { clientIpFromRequest } from "@/lib/request-ip";
import { readJsonRequestBody } from "@/lib/request-json";

const BODY_MAX_BYTES = 2 * 1024;
const inputSchema = z.object({
  email: z.string().trim().email().max(AUTH_EMAIL_MAX_LENGTH),
  password: z.string().min(1).max(AUTH_PASSWORD_MAX_LENGTH),
});

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store, max-age=0" };
  if (
    !sameOrigin(request) ||
    !request.headers.get("content-type")?.startsWith("application/json")
  ) {
    return NextResponse.json({ mfaRequired: false }, { status: 403, headers });
  }
  const body = await readJsonRequestBody(request, BODY_MAX_BYTES);
  const parsed = body.ok ? inputSchema.safeParse(body.data) : null;
  if (!parsed?.success) {
    return NextResponse.json({ mfaRequired: false }, { status: 400, headers });
  }

  const challenge = await validCredentialsSecondFactor({
    email: parsed.data.email,
    password: parsed.data.password,
    ip: clientIpFromRequest(request),
  });
  if (challenge.factor === "unavailable") {
    return NextResponse.json(
      {
        mfaRequired: false,
        factor: challenge.factor,
        message: "Secure sign-in is temporarily unavailable.",
      },
      { status: 503, headers },
    );
  }
  if (challenge.factor === "enrollment_required") {
    return NextResponse.json(
      {
        mfaRequired: false,
        factor: challenge.factor,
        message:
          "This administrator or operator must enroll a passkey before required-mode sign-in can continue.",
      },
      { status: 409, headers },
    );
  }
  return NextResponse.json(
    {
      mfaRequired:
        challenge.factor === "totp" || challenge.factor === "passkey",
      ...challenge,
    },
    { headers },
  );
}
