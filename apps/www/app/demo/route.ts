import { NextResponse } from "next/server";

// Some links (and the old README) point at openvpm.com/demo. Send them to the
// real demo login instead of 404ing. Kept as a redirect so the canonical demo
// URL can change without breaking inbound links.
const DEMO_URL = process.env.NEXT_PUBLIC_APP_URL
  ? `${process.env.NEXT_PUBLIC_APP_URL}/login`
  : "https://demo.openvpm.com/login";

export function GET() {
  return NextResponse.redirect(DEMO_URL, 307);
}
