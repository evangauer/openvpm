import { describe, expect, it } from "vitest";
import {
  createAppQueryClient,
  QUERY_GC_TIME_MS,
  QUERY_STALE_TIME_MS,
  shouldRetryQuery,
} from "../query-client";

describe("createAppQueryClient", () => {
  it("uses conservative global query defaults", () => {
    const defaults = createAppQueryClient().getDefaultOptions();

    expect(defaults.queries?.staleTime).toBe(QUERY_STALE_TIME_MS);
    expect(defaults.queries?.gcTime).toBe(QUERY_GC_TIME_MS);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
    expect(defaults.queries?.retry).toBe(shouldRetryQuery);
    expect(defaults.mutations?.retry).toBe(false);
  });
});

describe("shouldRetryQuery", () => {
  it("retries unknown transient failures once", () => {
    expect(shouldRetryQuery(0, new Error("network"))).toBe(true);
    expect(shouldRetryQuery(1, new Error("network"))).toBe(false);
  });

  it("does not retry expected tRPC client failures", () => {
    expect(
      shouldRetryQuery(0, { data: { code: "UNAUTHORIZED", httpStatus: 401 } })
    ).toBe(false);
    expect(
      shouldRetryQuery(0, { shape: { data: { code: "BAD_REQUEST" } } })
    ).toBe(false);
  });

  it("does not retry other 4xx responses", () => {
    expect(shouldRetryQuery(0, { status: 404 })).toBe(false);
    expect(shouldRetryQuery(0, { data: { httpStatus: 409 } })).toBe(false);
  });
});
