function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function clientIpFromRequest(req: unknown): string {
  const headers = (req as { headers?: unknown } | null)?.headers;
  const forwarded = headerValue(headers, "x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 45);
  return headerValue(headers, "x-real-ip")?.slice(0, 45) ?? "unknown";
}
