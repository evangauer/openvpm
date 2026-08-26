function firstHeaderValue(value: string | null): string | null {
  const first = value?.split(",", 1)[0]?.trim();
  return first || null;
}

/**
 * Returns the origin the browser addressed, rather than an internal proxy URL.
 * Host is intentionally preferred over forwarded-host: an untrusted client must
 * not be able to make a hostile Origin look same-origin by spoofing proxy data.
 */
export function externallyVisibleRequestOrigin(
  request: Pick<Request, "headers" | "url">,
): string {
  const internalUrl = new URL(request.url);
  const host = firstHeaderValue(request.headers.get("host")) ?? internalUrl.host;
  const forwardedProtocol = firstHeaderValue(
    request.headers.get("x-forwarded-proto"),
  );
  const protocol = forwardedProtocol
    ? forwardedProtocol.replace(/:$/, "")
    : internalUrl.protocol.replace(/:$/, "");

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return internalUrl.origin;
  }
}

export function isSameOriginRequest(
  request: Pick<Request, "headers" | "url">,
): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === externallyVisibleRequestOrigin(request);
}
