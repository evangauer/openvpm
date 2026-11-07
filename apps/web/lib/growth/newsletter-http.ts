const ORIGINS = new Set([
  "https://openvpm.com", "https://www.openvpm.com", "https://app.openvpm.com",
  "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:4000",
]);

export function newsletterOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || ORIGINS.has(origin);
}

export function newsletterJson(request: Request, body: unknown, status = 200): Response {
  const origin = request.headers.get("origin");
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", Vary: "Origin",
    ...(origin && ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
  } });
}

export function newsletterOptions(request: Request): Response {
  if (!newsletterOriginAllowed(request)) return new Response(null, { status: 403 });
  const origin = request.headers.get("origin");
  return new Response(null, { status: 204, headers: {
    Vary: "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600",
    ...(origin ? { "Access-Control-Allow-Origin": origin } : {}),
  } });
}
