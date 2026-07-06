import { readRequestTextWithLimit } from "./request-body";

export { readRequestTextWithLimit } from "./request-body";

export const JSON_REQUEST_BODY_MAX_BYTES = 64 * 1024;

export type JsonRequestBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: "invalid_json" | "too_large" };

export function jsonRequestContentLengthTooLarge(
  headers: Headers,
  maxBytes = JSON_REQUEST_BODY_MAX_BYTES
): boolean {
  const value = headers.get("content-length");
  if (!value) return false;

  const length = Number(value);
  return Number.isFinite(length) && length > maxBytes;
}

export async function readJsonRequestBody(
  request: Request,
  maxBytes = JSON_REQUEST_BODY_MAX_BYTES
): Promise<JsonRequestBodyResult> {
  if (jsonRequestContentLengthTooLarge(request.headers, maxBytes)) {
    return { ok: false, reason: "too_large" };
  }

  const body = await readRequestTextWithLimit(request, maxBytes);
  if (!body.ok) {
    return { ok: false, reason: "too_large" };
  }

  try {
    return { ok: true, data: JSON.parse(body.text) as unknown };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}
