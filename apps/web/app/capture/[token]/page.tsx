import { CaptureClient } from "./capture-client";

/**
 * No-login mobile page behind the in-consult QR capture link. We render the
 * uploader without checking the token server-side so the page itself never
 * acts as a token-validity oracle; a bad or expired token simply gets the
 * same generic error when an upload is attempted.
 */
export const dynamic = "force-dynamic";

export default async function CapturePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <CaptureClient token={token} />;
}
