import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import { hasBlankConfiguredNextAuthSecret } from "@/lib/auth-secret";

const handler = NextAuth(authOptions);

type RouteContext = {
  params: Promise<{ nextauth: string[] }>;
};

function guardedHandler(request: NextRequest, context: RouteContext) {
  if (hasBlankConfiguredNextAuthSecret()) {
    return NextResponse.json(
      { error: "Authentication secret is not configured" },
      { status: 503 }
    );
  }

  return handler(request, context);
}

export { guardedHandler as GET, guardedHandler as POST };
