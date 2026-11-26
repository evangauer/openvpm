import { notFound } from "next/navigation";
import { scribeRolloutEnabled } from "@/lib/scribe/availability";
import { ScribeCaptureClient } from "./scribe-capture-client";

/**
 * No-login phone page behind a Scribe QR link. Like the photo capture page,
 * it renders without checking the token server-side; the recorder asks the
 * API whether the link is still open before it offers to record.
 */
export const dynamic = "force-dynamic";

export default async function ScribeCapturePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  if (!scribeRolloutEnabled()) notFound();
  const { token } = await params;
  return <ScribeCaptureClient token={token} />;
}
