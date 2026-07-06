import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_FETCH_TIMEOUT_MS,
  clientFetchTimeoutMessage,
  fetchWithClientTimeout,
} from "../client-fetch";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("fetchWithClientTimeout", () => {
  it("passes an abort signal to fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithClientTimeout("/api/test")).resolves.toBeInstanceOf(
      Response
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/test",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
    expect(CLIENT_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts hung requests with a user-facing timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          })
      )
    );

    const result = expect(
      fetchWithClientTimeout("/api/slow", undefined, 1_000)
    ).rejects.toThrow(clientFetchTimeoutMessage(1_000));
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
  });

  it("preserves caller abort errors", async () => {
    const caller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("caller aborted"));
            });
          })
      )
    );

    const result = expect(
      fetchWithClientTimeout("/api/cancelled", { signal: caller.signal })
    ).rejects.toThrow("caller aborted");
    caller.abort();
    await result;
  });
});
