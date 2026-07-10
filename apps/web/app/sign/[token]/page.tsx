import { SignClient } from "./sign-client";

/**
 * No-login e-sign page behind the consent QR link. The consent content is
 * fetched client-side from the rate-limited token API, so this page renders
 * the same shell for every token and never widens the validity oracle
 * beyond the API itself.
 */
export const dynamic = "force-dynamic";

export default function SignPage({
  params,
}: {
  params: { token: string };
}) {
  return <SignClient token={params.token} />;
}
