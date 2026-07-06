export type ReadRequestBytesResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false };

export type ReadRequestTextResult =
  | { ok: true; text: string }
  | { ok: false };

export async function readRequestBytesWithLimit(
  request: Request,
  maxBytes: number
): Promise<ReadRequestBytesResult> {
  if (!request.body) {
    return { ok: true, bytes: new Uint8Array() };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }

    chunks.push(value);
  }

  if (chunks.length === 1) {
    return { ok: true, bytes: chunks[0]! };
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, bytes: body };
}

export async function readRequestTextWithLimit(
  request: Request,
  maxBytes: number
): Promise<ReadRequestTextResult> {
  const body = await readRequestBytesWithLimit(request, maxBytes);
  if (!body.ok) {
    return { ok: false };
  }

  return { ok: true, text: new TextDecoder().decode(body.bytes) };
}
