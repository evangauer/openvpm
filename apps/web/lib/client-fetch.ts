export const CLIENT_FETCH_TIMEOUT_MS = 15_000;
export const CLIENT_UPLOAD_TIMEOUT_MS = 60_000;

export function clientFetchTimeoutMessage(timeoutMs: number): string {
  return `Request timed out after ${Math.round(timeoutMs / 1000)} seconds`;
}

export async function fetchWithClientTimeout(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  timeoutMs = CLIENT_FETCH_TIMEOUT_MS
): Promise<Response> {
  if (timeoutMs <= 0) return fetch(input, init);

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const callerSignal = init?.signal;
  const abortFromCaller = () => controller.abort();
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(clientFetchTimeoutMessage(timeoutMs));
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
