import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { authOptions } from "@/lib/auth";
import { nextAuthSecretRejected } from "@/lib/auth-secret";

const handler = NextAuth(authOptions);

type RouteContext = {
  params: Promise<{ nextauth: string[] }>;
};

function guardedHandler(request: NextRequest, context: RouteContext) {
  if (nextAuthSecretRejected()) {
    return NextResponse.json(
      { error: "Authentication secret is not configured" },
      { status: 503 }
    );
  }

  return handler(request, context);
}

export { guardedHandler as GET, guardedHandler as POST };
